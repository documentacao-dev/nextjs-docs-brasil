use auto_hash_map::AutoSet;

use crate::{ResolvedVc, VcValueTrait};

/// Implemented on `OperationVc`.
pub trait CollectiblesSource {
    /// The collectibles of type `T` emitted by the source's task and its subgraph. Reading them
    /// doesn't remove them: they still reach the uppers of the reading task.
    fn peek_collectibles<T: VcValueTrait>(self) -> AutoSet<ResolvedVc<T>>;
}
