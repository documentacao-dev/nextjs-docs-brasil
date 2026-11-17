//! Stateless queries for server HMR.
//!
//! Server HMR pulls are lazy and per route, but every route that runs in a
//! runtime shares its module cache, and a chunk that loads doesn't replace a
//! factory the runtime already has. So which code a runtime runs can only be
//! known by the runtime itself: development runtimes record the hash of every
//! factory they install, and the caller compares those with the current hashes
//! of the requested route's chunks, then asks for the code of the modules to
//! ship. Nothing about what the runtimes loaded is kept here.

use std::{
    fmt::Display,
    sync::{Arc, LazyLock},
};

use anyhow::Result;
use serde::Serialize;
use turbo_rcstr::RcStr;
use turbo_tasks::{
    FxIndexMap, FxIndexSet, NonLocalValue, ReadRef, ResolvedVc, TransientInstance, TryJoinIterExt,
    Vc,
    debug::ValueDebugFormat,
    message_queue::{CompilationEvent, Severity},
    turbo_tasks,
};
use turbo_tasks_hash::hash_xxh3_hash128;
use turbopack_core::chunk::ModuleId;
use turbopack_ecmascript::hmr::EcmascriptHmrChunkContent;
pub use turbopack_ecmascript::{
    chunk_list::merged_update::EcmascriptModuleEntry,
    hmr::version::{EcmascriptChunkVersion, module_hash_string},
};
use turbopack_nodejs::ecmascript::node::entry::chunk_list_content::EcmascriptBuildNodeChunkListContent;

#[derive(Clone, PartialEq, Eq, ValueDebugFormat, NonLocalValue)]
pub struct ServerHmrChunkList {
    pub relative_path: RcStr,
    pub versioned_content: ResolvedVc<EcmascriptBuildNodeChunkListContent>,
}

#[turbo_tasks::value(transparent, serialization = "skip")]
#[derive(Clone)]
pub struct ServerHmrChunkLists(Vec<ServerHmrChunkList>);

impl ServerHmrChunkLists {
    pub fn new(chunk_lists: Vec<ServerHmrChunkList>) -> Self {
        Self(chunk_lists)
    }

    pub fn as_slice(&self) -> &[ServerHmrChunkList] {
        &self.0
    }

    pub fn retain_entry_paths(&mut self, entry_paths: &FxIndexSet<RcStr>) {
        self.0
            .retain(|chunk_list| entry_paths.contains(&chunk_list.relative_path));
    }
}

/// One JavaScript chunk of the requested route, with its current version.
#[derive(Clone, PartialEq, Eq, ValueDebugFormat, NonLocalValue)]
pub struct ServerHmrRouteChunk {
    pub content: ResolvedVc<Box<dyn EcmascriptHmrChunkContent>>,
    pub version: ReadRef<EcmascriptChunkVersion>,
    /// The id of `version`. It changes whenever any module of the chunk changes, or which modules
    /// the chunk holds.
    pub version_id: RcStr,
}

/// Reads the JavaScript chunks of `chunk_lists`, with their versions.
pub async fn server_hmr_route_chunks(
    chunk_lists: &[ServerHmrChunkList],
) -> Result<Vec<ServerHmrRouteChunk>> {
    let mut chunks = FxIndexMap::default();
    for chunk_list in chunk_lists {
        for (path, content) in chunk_list.versioned_content.await?.chunks_contents() {
            // Other chunks are not loaded as JavaScript, so there is nothing to update.
            if let Some(content) =
                ResolvedVc::try_sidecast::<Box<dyn EcmascriptHmrChunkContent>>(*content)
            {
                chunks.entry(path.clone()).or_insert(content);
            }
        }
    }
    chunks
        .into_values()
        .map(async |content| {
            let version = content.ecmascript_chunk_version().await?;
            Ok(ServerHmrRouteChunk {
                content,
                version_id: version.id_sync(),
                version,
            })
        })
        .try_join()
        .await
}

/// The input of [`server_hmr_module_code_operation`].
#[derive(NonLocalValue)]
pub struct ServerHmrModuleCodeInput {
    pub chunks: Vec<ServerHmrRouteChunk>,
    /// The ids of the modules to read, by chunk path.
    pub request: FxIndexMap<RcStr, Vec<ModuleId>>,
}

/// The code of requested modules of one chunk.
#[derive(Clone, Debug, PartialEq, Eq, ValueDebugFormat, NonLocalValue)]
pub struct ServerHmrChunkModules {
    pub chunk_path: RcStr,
    /// The id of the chunk's version the code was read from.
    pub version_id: RcStr,
    /// The update entry of every requested module the chunk holds, with the hash of exactly its
    /// code.
    pub entries: Vec<(ModuleId, EcmascriptModuleEntry, u128)>,
    /// Requested modules the chunk doesn't hold (anymore).
    pub missing: Vec<ModuleId>,
}

/// The result of [`server_hmr_module_code_operation`].
#[turbo_tasks::value(transparent, serialization = "skip")]
pub struct ServerHmrModuleCode(Vec<ServerHmrChunkModules>);

/// Reads the code of the requested modules of the route's chunks.
///
/// Kept outside of the snapshot operation so that the request, which changes with every pull,
/// never becomes part of a cached task. Requested chunks that aren't chunks of the route are left
/// out, so the caller sees them as changed.
#[turbo_tasks::function(operation, root)]
pub async fn server_hmr_module_code_operation(
    input: TransientInstance<ServerHmrModuleCodeInput>,
) -> Result<Vc<ServerHmrModuleCode>> {
    let ServerHmrModuleCodeInput { chunks, request } = &*input;
    let mut result = Vec::new();
    for chunk in chunks {
        let Some(ids) = request.get(&chunk.version.chunk_path) else {
            continue;
        };
        let chunk_path = &chunk.version.chunk_path;
        let chunk_entries = chunk.content.entries().await?;
        let mut entries = Vec::new();
        let mut missing = Vec::new();
        for id in ids {
            let Some(entry) = chunk_entries.get(id) else {
                missing.push(id.clone());
                continue;
            };
            let entry = EcmascriptModuleEntry::from_code(id, *entry.code, chunk_path).await?;
            // The hash of the code that is sent, as development chunks hash their factories.
            let hash = hash_xxh3_hash128(&entry.code);
            entries.push((id.clone(), entry, hash));
        }
        result.push(ServerHmrChunkModules {
            chunk_path: chunk_path.clone(),
            version_id: chunk.version_id.clone(),
            entries,
            missing,
        });
    }
    Ok(Vc::cell(result))
}

static TRACE_DIFFING: LazyLock<bool> = LazyLock::new(|| {
    cfg!(debug_assertions) && std::env::var_os("NEXT_TEST_SERVER_HMR_DIFFING").is_some()
});

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerHmrChunkListDiffEvent {
    #[serde(rename = "entryPath")]
    chunk_list_path: RcStr,
}

impl Display for ServerHmrChunkListDiffEvent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Diffing server HMR entry {}", self.chunk_list_path)
    }
}

impl CompilationEvent for ServerHmrChunkListDiffEvent {
    fn type_name(&self) -> &'static str {
        "ServerHmrEntryDiffEvent"
    }

    fn severity(&self) -> Severity {
        Severity::Trace
    }

    fn message(&self) -> String {
        self.to_string()
    }

    fn to_json(&self) -> String {
        serde_json::to_string(self).expect("server HMR entry diff event serializes")
    }
}

/// Reports which chunk lists a pull reads, for tests that check that pulls stay per route.
pub fn trace_server_hmr_diffs(chunk_lists: &[ServerHmrChunkList]) {
    if *TRACE_DIFFING {
        for chunk_list in chunk_lists {
            turbo_tasks().send_compilation_event(Arc::new(ServerHmrChunkListDiffEvent {
                chunk_list_path: chunk_list.relative_path.clone(),
            }));
        }
    }
}
