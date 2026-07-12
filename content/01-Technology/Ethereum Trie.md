---
title: "Ethereum Trie"
source: obsidian/01-Technology
---



https://easythereentropy.wordpress.com/2014/06/04/understanding-the-ethereum-trie/

  

## NODE_TYPE_EXTENSION

- Shape: 2-item node `[encoded_partial_key, child_pointer]`

- Purpose: path compression

- Meaning: “for this shared key prefix, there is only one next path”

- Traversal behavior:

- Verify search key starts with this prefix

- Strip prefix

- Continue to the single child

  

## NODE_TYPE_BRANCH

- Shape: 17-item node `[child0..child15, value_slot]`

- Purpose: nibble fan-out

- Meaning: “at this point, next nibble chooses one of up to 16 children”

- Traversal behavior:

- If no key left, return `value_slot` (index 16)

- Else route using next nibble index `0..15`

  

## Practical intuition

- Extension node = compressed straight road segment

- Branch node = intersection with up to 16 exits plus optional value exactly at that intersection