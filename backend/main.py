import os
import random
from pathlib import Path
from typing import List, Tuple
from dataclasses import dataclass

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.responses import PlainTextResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi import APIRouter

from database import get_db  # noqa: F401 — imported for future use

app = FastAPI(title="Rooms of Roaming API", version="0.1.0")

# Mount static directory (frontend)
static_dir = Path(__file__).resolve().parent / "static"
app.mount("/static", StaticFiles(directory=static_dir), name="static")

api_router = APIRouter(prefix="/api")

CHUNK_SIZE = 48  # 48x48 grid per chunk - better for room generation
WALL_CHAR = "#"
FLOOR_CHAR = " "


@dataclass
class BoundaryConstraints:
    """Defines which boundary points must be corridors for chunk connectivity."""
    north: List[int]  # x-coordinates on north boundary (y=0)
    south: List[int]  # x-coordinates on south boundary (y=height-1)
    east: List[int]   # y-coordinates on east boundary (x=width-1)
    west: List[int]   # y-coordinates on west boundary (x=0)


@dataclass
class Room:
    x: int
    y: int
    width: int
    height: int
    
    @property
    def center(self) -> Tuple[int, int]:
        return (self.x + self.width // 2, self.y + self.height // 2)
    
    def intersects(self, other: 'Room', padding: int = 1) -> bool:
        """Check if this room intersects with another room (with padding)."""
        return not (
            self.x + self.width + padding <= other.x or
            other.x + other.width + padding <= self.x or
            self.y + self.height + padding <= other.y or
            other.y + other.height + padding <= self.y
        )


def get_boundary_constraints(chunk_x: int, chunk_y: int, chunk_size: int) -> BoundaryConstraints:
    """
    Determine which boundary points must be corridors for seamless chunk connection.
    Uses adjacent chunk coordinates to ensure matching boundaries.
    """
    # Create deterministic boundary points based on chunk coordinates
    # Each boundary should have 1-2 connection points
    
    def get_boundary_points(cx: int, cy: int, side: str) -> List[int]:
        """Get 1-2 boundary connection points for a specific side."""
        # Create seed that's consistent for both chunks sharing this boundary
        if side == 'north':
            # North boundary is shared with chunk (cx, cy-1)'s south boundary
            seed = _seed_from_coords(cx, cy - 1) ^ _seed_from_coords(cx, cy)
        elif side == 'south':
            # South boundary is shared with chunk (cx, cy+1)'s north boundary  
            seed = _seed_from_coords(cx, cy) ^ _seed_from_coords(cx, cy + 1)
        elif side == 'west':
            # West boundary is shared with chunk (cx-1, cy)'s east boundary
            seed = _seed_from_coords(cx - 1, cy) ^ _seed_from_coords(cx, cy)
        elif side == 'east':
            # East boundary is shared with chunk (cx+1, cy)'s west boundary
            seed = _seed_from_coords(cx, cy) ^ _seed_from_coords(cx + 1, cy)
        else:
            seed = 0
            
        rng = random.Random(seed)
        
        # Generate 1-2 connection points, avoiding edges
        num_points = rng.randint(1, 2)
        points = []
        
        # Ensure points are well-spaced and not too close to corners
        margin = 4
        available_range = chunk_size - 2 * margin
        
        if available_range > 0:
            for _ in range(num_points):
                point = rng.randint(margin, chunk_size - margin - 1)
                # Ensure points aren't too close to each other
                if not points or all(abs(point - existing) >= 6 for existing in points):
                    points.append(point)
        
        return sorted(points)
    
    return BoundaryConstraints(
        north=get_boundary_points(chunk_x, chunk_y, 'north'),
        south=get_boundary_points(chunk_x, chunk_y, 'south'),
        east=get_boundary_points(chunk_x, chunk_y, 'east'),
        west=get_boundary_points(chunk_x, chunk_y, 'west')
    )


class DungeonGenerator:
    def __init__(self, width: int, height: int, seed: int, boundary_constraints: BoundaryConstraints):
        self.width = width
        self.height = height
        self.rng = random.Random(seed)
        self.grid = [[WALL_CHAR for _ in range(width)] for _ in range(height)]
        self.rooms: List[Room] = []
        self.boundary_constraints = boundary_constraints
        self.boundary_points: List[Tuple[int, int]] = []
    
    def generate(self) -> List[str]:
        """Generate a complete dungeon with boundary constraints."""
        self._create_boundary_corridors()
        self._generate_rooms()
        self._create_room_floors()
        self._connect_rooms_with_hallways()
        self._connect_to_boundary_points()
        return ["".join(row) for row in self.grid]
    
    def _create_boundary_corridors(self):
        """Create corridor openings at required boundary points."""
        # North boundary (y=0)
        for x in self.boundary_constraints.north:
            if 0 <= x < self.width:
                self.grid[0][x] = FLOOR_CHAR
                self.boundary_points.append((x, 0))
        
        # South boundary (y=height-1)
        for x in self.boundary_constraints.south:
            if 0 <= x < self.width:
                self.grid[self.height - 1][x] = FLOOR_CHAR
                self.boundary_points.append((x, self.height - 1))
        
        # West boundary (x=0)
        for y in self.boundary_constraints.west:
            if 0 <= y < self.height:
                self.grid[y][0] = FLOOR_CHAR
                self.boundary_points.append((0, y))
        
        # East boundary (x=width-1)
        for y in self.boundary_constraints.east:
            if 0 <= y < self.height:
                self.grid[y][self.width - 1] = FLOOR_CHAR
                self.boundary_points.append((self.width - 1, y))

    def _generate_rooms(self):
        """Generate rooms using a modified approach from the dungeon generator."""
        attempts = 0
        max_attempts = 100
        min_rooms = 3
        max_rooms = 8
        
        while len(self.rooms) < max_rooms and attempts < max_attempts:
            # Room size based on chunk size - smaller rooms for better fit
            min_size = 4
            max_size = min(12, self.width // 4, self.height // 4)
            
            width = self.rng.randint(min_size, max_size)
            height = self.rng.randint(min_size, max_size)
            
            # Random position with some margin from edges
            margin = 3  # Increased margin to avoid boundary corridors
            x = self.rng.randint(margin, self.width - width - margin)
            y = self.rng.randint(margin, self.height - height - margin)
            
            new_room = Room(x, y, width, height)
            
            # Check if room intersects with existing rooms or boundary corridors
            if (not any(new_room.intersects(room, padding=2) for room in self.rooms) and
                not self._room_blocks_boundary_corridors(new_room)):
                self.rooms.append(new_room)
            
            attempts += 1
        
        # Ensure we have at least minimum rooms
        if len(self.rooms) < min_rooms:
            self._force_generate_rooms(min_rooms - len(self.rooms))

    def _room_blocks_boundary_corridors(self, room: Room) -> bool:
        """Check if a room would block access to boundary corridor points."""
        for bx, by in self.boundary_points:
            # Check if room is too close to boundary points
            if (room.x - 2 <= bx <= room.x + room.width + 1 and
                room.y - 2 <= by <= room.y + room.height + 1):
                return True
        return False

    def _connect_to_boundary_points(self):
        """Ensure all boundary points are connected to the dungeon interior."""
        if not self.rooms:
            return
            
        for bx, by in self.boundary_points:
            # Find the closest room to this boundary point
            closest_room = min(self.rooms, 
                             key=lambda room: abs(room.center[0] - bx) + abs(room.center[1] - by))
            
            # Create a connection from boundary point to closest room
            self._create_hallway(closest_room.center, (bx, by))

    def _force_generate_rooms(self, count: int):
        """Force generate rooms in remaining space."""
        for _ in range(count):
            for _ in range(50):  # Try 50 times to place a room
                width = self.rng.randint(3, 6)
                height = self.rng.randint(3, 6)
                x = self.rng.randint(2, self.width - width - 2)
                y = self.rng.randint(2, self.height - height - 2)
                
                new_room = Room(x, y, width, height)
                if (not any(new_room.intersects(room, padding=1) for room in self.rooms) and
                    not self._room_blocks_boundary_corridors(new_room)):
                    self.rooms.append(new_room)
                    break
    
    def _create_room_floors(self):
        """Carve out floor tiles for each room."""
        for room in self.rooms:
            for y in range(room.y, room.y + room.height):
                for x in range(room.x, room.x + room.width):
                    if 0 <= x < self.width and 0 <= y < self.height:
                        self.grid[y][x] = FLOOR_CHAR
    
    def _connect_rooms_with_hallways(self):
        """Connect rooms with L-shaped hallways."""
        if len(self.rooms) < 2:
            return
        
        # Connect each room to the next one in a chain
        for i in range(len(self.rooms) - 1):
            room1 = self.rooms[i]
            room2 = self.rooms[i + 1]
            self._create_hallway(room1.center, room2.center)
        
        # Add some additional connections for more interesting layouts
        if len(self.rooms) >= 3:
            # Connect first and last room
            self._create_hallway(self.rooms[0].center, self.rooms[-1].center)
            
            # Add one random connection if we have enough rooms
            if len(self.rooms) >= 4:
                idx1 = self.rng.randint(0, len(self.rooms) - 1)
                idx2 = self.rng.randint(0, len(self.rooms) - 1)
                if idx1 != idx2:
                    self._create_hallway(self.rooms[idx1].center, self.rooms[idx2].center)
    
    def _create_hallway(self, start: Tuple[int, int], end: Tuple[int, int]):
        """Create an L-shaped hallway between two points."""
        x1, y1 = start
        x2, y2 = end
        
        # Decide whether to go horizontal first or vertical first
        if self.rng.choice([True, False]):
            # Horizontal first, then vertical
            self._carve_horizontal_tunnel(x1, x2, y1)
            self._carve_vertical_tunnel(y1, y2, x2)
        else:
            # Vertical first, then horizontal
            self._carve_vertical_tunnel(y1, y2, x1)
            self._carve_horizontal_tunnel(x1, x2, y2)
    
    def _carve_horizontal_tunnel(self, x1: int, x2: int, y: int):
        """Carve a horizontal tunnel."""
        if x1 > x2:
            x1, x2 = x2, x1
        
        for x in range(x1, x2 + 1):
            if 0 <= x < self.width and 0 <= y < self.height:
                self.grid[y][x] = FLOOR_CHAR
    
    def _carve_vertical_tunnel(self, y1: int, y2: int, x: int):
        """Carve a vertical tunnel."""
        if y1 > y2:
            y1, y2 = y2, y1
        
        for y in range(y1, y2 + 1):
            if 0 <= x < self.width and 0 <= y < self.height:
                self.grid[y][x] = FLOOR_CHAR


def _seed_from_coords(x: int, y: int) -> int:
    """Create deterministic seed from chunk coordinates."""
    return (x * 73856093) ^ (y * 19349663)


def generate_chunk(x: int, y: int) -> List[str]:
    """Generate a dungeon chunk with boundary constraints for seamless connectivity."""
    seed = _seed_from_coords(x, y)
    boundary_constraints = get_boundary_constraints(x, y, CHUNK_SIZE)
    generator = DungeonGenerator(CHUNK_SIZE, CHUNK_SIZE, seed, boundary_constraints)
    return generator.generate()


@api_router.get("/map", response_model=list[str])
async def get_map_chunk(
    x: int = Query(0, description="Chunk X coordinate"),
    y: int = Query(0, description="Chunk Y coordinate"),
):
    """Return procedurally generated dungeon chunk at given coordinates."""
    if abs(x) > 1_000_000 or abs(y) > 1_000_000:
        raise HTTPException(status_code=400, detail="Invalid chunk coordinates")
    return generate_chunk(x, y)


@api_router.get("/readme", response_class=PlainTextResponse)
async def get_readme() -> str:
    """Return the project README file as plain text."""
    readme_path = Path(__file__).resolve().parent / "README.md"
    if not readme_path.exists():
        raise HTTPException(status_code=404, detail="README not found")
    return readme_path.read_text(encoding="utf-8")


# Root route serves the frontend

@app.get("/", response_class=HTMLResponse)
async def root() -> str:
    index_path = static_dir / "index.html"
    return index_path.read_text(encoding="utf-8")

app.include_router(api_router) 