[![make.fun](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![make.fun rank](https://make.fun/badge/sokoban-solver-01-run-20261121/iwanr94/sokoban-solver/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![make.fun reward](https://make.fun/badge/sokoban-solver-01-run-20261121/iwanr94/sokoban-solver/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

# rooms-bfs (sokoban-solver-01)

A push-optimal Sokoban solver for make.fun's `sokoban-solver-01-run-20261121` bounty. One run answers the whole set:
it reads `/input/i001` to `/input/i005` (`level.txt`, XSB) and writes `/output/<id>/solution.txt` in LURD letters.

## How it solves

1. **Rooms.** Every level is a one-square hallway with 1 to 4 rooms off it. A box pushed through a room's door lands
   in the hallway, where nothing can push it back, so each box stays in its room and the level's push optimum P* is the
   sum of the rooms' optima. The solver marks the squares a box can still reach a goal from (reverse pushes from the
   goals), cuts the player's hallway row out of the floor, and takes each remaining connected part holding boxes as a
   room.
2. **Push-optimal per room.** Each room is solved by a breadth-first search over push states — the boxes' squares plus
   the player's reachable region (named by its lowest square) — so the first solved state it meets is optimal. The
   other rooms' boxes stand as walls while a room is solved (their goals are walkable), and the player walks on from
   where the previous room left it. The walks between pushes are shortest paths, replayed as lower-case steps, pushes
   upper-case.
3. **Deadlocks.** States are pruned only when no push could save them: dead squares (a box there can never reach any
   goal, which also covers corners), and a 2 x 2 block of walls and boxes holding a box off its goal (frozen).

## Determinism and budget

No randomness, no clock, no environment as a source of variation: every search stops on a fixed count of states
(400,000 per room, 2,000,000 on a retry, 6,000,000 for the set), so two executions produce byte-identical output. The
practice set solves in about one second.

## Run and grade locally

    # run by hand (skip the /input, /output mounts)
    MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=/tmp/out node main.ts

    # grade as the server does, from the kit's directory
    node cli/makefun.mjs grade-local --kit . \
      --bot <this repository> --driver process --worktree

Practice set: 1,000,000 of 1,000,000 (all five instances in exactly P* pushes). The house baseline, plain-astar 1.0.0,
scores 200,000 on the same set.

Node 22.18 or later runs `main.ts` as it is (types are stripped); on 22.6 to 22.17 use `node --experimental-strip-types`.

## Licence

MIT, see LICENSE.
