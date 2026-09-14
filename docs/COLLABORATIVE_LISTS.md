# Collaborative list projection in yuNote

yuNote persists collaborative lists in the same visible `lists` and `list_items` tables as personal data, with explicit `purpose`, `sharing_mode`, `shared_revision`, and `collaboration_role` fields. SQL guards reject invalid Partner lists, incomplete collaboration metadata, and a checked Shared item without a completion actor.

Manual edits and Key Fob structured actions share `collaborativeListOperations.ts`. The local item mutation, revision increment, and `collaboration_outbox` insert form one transaction. Collaborative operations never enter the personal `mutation_journal` or `sync_outbox`.

`installationSync.ts` drains personal journal data first, then collaborative outbox operations, then the collaboration inbox. A stale collaborative revision causes Cloud to enqueue a fresh projection. `collaborationInbox.ts` treats the latest projection in a batch as the recovery boundary, installs it, and reapplies pending local operations in expected-revision order before acknowledgement. Empty signed `discard` deliveries preserve the inbox cursor after access revocation. A `403` retires pending operations for the revoked list so the removal projection can still be processed.

Full projections replace only the named collaborative list. A Partner activation projection may additionally name that account's exact former personal Shopping List; yuNote validates its type and removes it atomically before installing the Partner projection. It does not clear personal notes, generic lists, or other collaborative projections. A Shared completion stores the public completion profile. Avatar bytes are fetched separately through the signed installation channel and cached in `collaboration_members`; completed Partner and Personal items continue to use ordinary checkboxes.

The two-rings marker is presentation derived only from `sharing_mode=partner`. The title remains `Shopping List`, so existing shopping voice commands continue to resolve to it through the cloud candidate provider.
