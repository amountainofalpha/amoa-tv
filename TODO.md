# TODO

- **Hidden overlays hold plot slots.** Since hidden overlays keep their
  study data live across symbol switches (silent replace), they occupy a
  plot slot. With more overlays than the Pine has plots, a hidden overlay
  can force an eviction a visible one wouldn't have. Consider preferring
  hidden metrics when `claimSlot` needs to evict.
