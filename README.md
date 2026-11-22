# Sokoban Solver

Room-decomposed push-optimal Sokoban solver for make.fun's sokoban-solver-01-run-20261121.

[![make.fun](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/c/sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/iwanr94/sokoban-solver/rank.svg)](https://make.fun/c/sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/iwanr94/sokoban-solver/reward.svg)](https://make.fun/c/sokoban-solver-01-run-20261121)

## How it works

A level is a hallway with one to four rooms off it, and a box pushed
through a door into the hallway can never be pushed back, so every box
stays in its room and the level's push-optimum is the sum of its rooms'
optima. This solver splits each level into its rooms, solves every room
with A* over pushes, and stitches the rooms together with hallway walks.

Each room search uses an admissible assignment heuristic (cheapest
box-to-goal matching by box-ignoring distance) with dead-square, corner,
2x2-block and frozen-box pruning. The program is deterministic: no clock,
no randomness, every search bounded by a node count, never by time.

## Run

Node 22, standard library only:

```
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` reads every instance under the input directory and writes
`<id>/solution.txt` (a string of `u`, `d`, `l`, `r` moves) under the
output directory. Practice set: 1,000,000 points (5/5 instances at
their push-optimal counts).

## License

MIT
