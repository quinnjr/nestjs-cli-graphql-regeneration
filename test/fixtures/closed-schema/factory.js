'use strict';

// Negative-control fixture factory: a trivial no-op, paired with a schema.json that sets
// additionalProperties: false. Never shipped -- exists only so the test suite can prove the
// validation mechanism actually rejects undeclared properties when a schema is closed.
function closed() {
  return (tree) => tree;
}

module.exports = { closed };
