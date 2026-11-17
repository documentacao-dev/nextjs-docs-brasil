use anyhow::Result;
use turbo_rcstr::RcStr;
use turbo_tasks::{FxIndexMap, ReadRef, TryJoinIterExt, Vc, turbobail};
use turbo_tasks_fs::FileSystemPath;
use turbo_tasks_hash::{Xxh3Hash64Hasher, encode_base64};
use turbopack_core::{
    chunk::{MinifyType, ModuleId},
    version::Version,
};

use crate::chunk::{EcmascriptChunkContent, EcmascriptChunkContentEntries};

/// The version of a single Ecmascript chunk's content, tracked as the set of
/// per-module content hashes.
///
/// Runtime-agnostic: the browser and node chunking contexts share this one
/// implementation rather than each carrying a copy. `minify_type` participates
/// in the hash because minification changes the emitted bytes without changing
/// any module's own hash.
#[turbo_tasks::value(serialization = "skip")]
pub struct EcmascriptChunkVersion {
    pub chunk_path: RcStr,
    pub minify_type: MinifyType,
    pub entries_hashes: FxIndexMap<ModuleId, u128>,
}

#[turbo_tasks::value_impl]
impl EcmascriptChunkVersion {
    #[turbo_tasks::function]
    pub async fn new(
        output_root: FileSystemPath,
        chunk_path: FileSystemPath,
        content: Vc<EcmascriptChunkContent>,
        minify_type: MinifyType,
    ) -> Result<Vc<Self>> {
        let Some(chunk_path) = output_root.get_path_to(&chunk_path) else {
            turbobail!("chunk path {chunk_path} is not in output root {output_root}");
        };
        let entries_hashes = EcmascriptChunkContentEntries::new(content)
            .await?
            .iter()
            .map(async |(id, entry)| Ok((id.clone(), *entry.hash.await?)))
            .try_join()
            .await?
            .into_iter()
            .collect();

        Ok(EcmascriptChunkVersion {
            chunk_path: chunk_path.into(),
            minify_type,
            entries_hashes,
        }
        .cell())
    }
}

impl EcmascriptChunkVersion {
    /// The id of this version, without going through a task, see [`Version::id`]. It identifies
    /// which module has which code, so a change of either changes it.
    pub fn id_sync(&self) -> RcStr {
        let mut hasher = Xxh3Hash64Hasher::new();
        hasher.write_ref(&self.chunk_path);
        hasher.write_ref(&self.minify_type);
        let mut sorted_modules: Vec<_> = self
            .entries_hashes
            .iter()
            .map(|(id, hash)| (id, *hash))
            .collect();
        sorted_modules.sort();
        hasher.write_value(sorted_modules.len());
        for (id, hash) in sorted_modules {
            hasher.write_ref(id);
            hasher.write_value(hash);
        }
        encode_base64(hasher.finish()).into()
    }
}

/// The string form of a module's hash, as development chunks and server HMR updates carry it.
/// It is lossless, unlike a JavaScript number.
pub fn module_hash_string(hash: u128) -> String {
    format!("{hash:032x}")
}

#[turbo_tasks::value_impl]
impl Version for EcmascriptChunkVersion {
    #[turbo_tasks::function]
    fn id(&self) -> Vc<RcStr> {
        Vc::cell(self.id_sync())
    }
}

/// The version of a [`super::content::EcmascriptMergedChunkContent`]. This is
/// essentially a composite [`EcmascriptChunkVersion`].
#[turbo_tasks::value(serialization = "skip", shared)]
pub struct EcmascriptMergedChunkVersion {
    pub versions: Vec<ReadRef<EcmascriptChunkVersion>>,
}

#[turbo_tasks::value_impl]
impl Version for EcmascriptMergedChunkVersion {
    #[turbo_tasks::function]
    async fn id(&self) -> Result<Vc<RcStr>> {
        let mut hasher = Xxh3Hash64Hasher::new();
        hasher.write_value(self.versions.len());
        let sorted_ids = {
            let mut sorted_ids = self
                .versions
                .iter()
                // This `ReadRef::cell` call is important: it ensures the id is
                // computed from a cell, so it is cached.
                .map(|version| ReadRef::cell(version.clone()).id())
                .try_join()
                .await?;
            sorted_ids.sort();
            sorted_ids
        };
        for id in sorted_ids {
            hasher.write_value(id);
        }
        let hash = hasher.finish();
        let hash = encode_base64(hash);
        Ok(Vc::cell(hash.into()))
    }
}

#[cfg(test)]
mod tests {
    use turbopack_core::chunk::{MinifyType, ModuleId};

    use super::EcmascriptChunkVersion;

    fn id_of(modules: &[(&str, u128)]) -> turbo_rcstr::RcStr {
        EcmascriptChunkVersion {
            chunk_path: "chunks/a.js".into(),
            minify_type: MinifyType::NoMinify,
            entries_hashes: modules
                .iter()
                .map(|(id, hash)| (ModuleId::String((*id).into()), *hash))
                .collect(),
        }
        .id_sync()
    }

    #[test]
    fn id_does_not_depend_on_module_order() {
        assert_eq!(id_of(&[("a", 1), ("b", 2)]), id_of(&[("b", 2), ("a", 1)]));
    }

    #[test]
    fn id_depends_on_which_module_has_which_code() {
        assert_ne!(id_of(&[("a", 1), ("b", 2)]), id_of(&[("a", 2), ("b", 1)]));
        assert_ne!(id_of(&[("a", 1)]), id_of(&[("b", 1)]));
    }
}
