# THE ROOMS OF ROAMING
Minimal online exploration and sharing space

## CONCEPT
Rooms of Roaming is an interactive exploration space that is:
* Open Ended - new parts of the map are procedurally generated as users explore
* Shared - each user is exploring the same map, starting at the same spot
* Collaborative - as you wander away from the spawn, you are awarded with **Chalk Points** you can use this to **append characters to stone tablets scattered around the map**. You can leave some thoughts, questions for other projects, poetry, ascii art and whatever you can come up with using your limited characters count. Once put on the tablet, characters cannot be removed by anyone.
* Minimal and meditative - the map is rendered with ascii art on 2d grid with symbols for walls, your character and tablets. You don't see other players, only their words left on the stone tablets once you reach them. Your moving speed is restricted (one grid step every few seconds).

## INITIAL VERSION
* Randomly generated chunked map (random 50% walls 50% no walls, no structure, no tablets)
* Option to display this README as project info
* Basic navigation (no collision with walls, no artificial slow down)

## TECHNOLOGY STACK
* frontend - to be decided
* backend - fastapi, sql, numpy