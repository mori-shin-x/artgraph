# Inline-link source

Plain inline link: [target](./target.md).

With anchor: [target-anchor](./target.md#section).

With query: [target-query](./target.md?v=1).

With anchor and query: [target-both](./target.md?v=1#x).

Percent-encoded: [encoded](./target%2Emd).

Image is ignored: ![alt](./target.md)

Pure fragment is ignored: [self](#section)

Empty href is ignored: [empty]()

External URL ignored: [ext](https://example.com/design.md)

mailto ignored: [mail](mailto:foo@example.com)

Non-md ignored: [code](./source.ts)
