# Symbol Demo Spec

This is the spec dir that `plan-coverage` analyses for the spec 016 fixture.
The body intentionally contains no requirement identifiers so the mention
detector does not eclipse `implicitImpacts` during testing. Requirement
definitions live in a sibling spec dir (`specs/auth-design/`) — the graph
scanner picks them up via `specDirs`, but their bodies stay out of this
file's mention-detection text.
