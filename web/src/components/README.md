# components

Building blocks used by several features: `Modal.tsx`, `Select.tsx`, `MenuSheet.tsx`, `ConfirmDialog.tsx`,
`icons.tsx`, `toast.tsx`, form parts and small pills and buttons. They know nothing about a single feature.
Component files are PascalCase; files that export many small parts (`icons.tsx`, `toast.tsx`, `formParts.tsx`) keep
their lower-case name.
