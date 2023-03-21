# @arthurfiorette/jest-prisma

This package is a forked version of `@quaramy/jest-prisma` with support for custom prisma client outputs. You should only use this package until the https://github.com/Quramy/jest-prisma/pull/75 is merged.

# This also introduces a feature.

When your `describe` have `[jest-prisma-group]` in the name, all children `describe`/`it` statements will be grouped together within the same transaction.
