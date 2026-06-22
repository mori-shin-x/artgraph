# Design (multi-dot file name)

Regression fixture for issue #36. `my.design.md` should have stem `my.design`
after the extension is stripped — i.e. it must NOT match the `design`
convention. The fix replaced `/\.[^.]*$/` with `/\.(md|markdown)$/i` so that
the implementation now matches the comment's "strip extension" intent.
