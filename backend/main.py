import os
import random
import math
import time
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

# Boundary corridor configuration
ADDITIONAL_CORRIDOR_PROBABILITY = 0.15  # 15% chance for extra corridors
MAX_ADDITIONAL_CORRIDORS = 3  # Maximum extra corridors per boundary
MIN_CORRIDOR_SPACING = 4  # Minimum distance between additional corridors

# Room size distribution configuration
MIN_ROOM_SIZE = 3  # Absolute minimum room size
MAX_ROOM_SIZE = 44  # Maximum room size (can be chunk-sized for ultra-rare cases)
BASE_ROOM_SIZE = 12  # Base room size for frequency calculations
NUM_FREQUENCIES = 6  # Number of frequency bands
MIN_WAVELENGTH_MULT = 10.0  # Minimum wavelength multiplier (room_size units)
MAX_WAVELENGTH_MULT = 100.0  # Maximum wavelength multiplier (room_size units)

# Base alpha/beta values that get modulated by frequencies
BASE_ALPHA = 1.5
BASE_BETA = 2.5
FREQUENCY_INFLUENCE = 3.0  # How much frequencies affect the distribution


# Global frequency parameters (generated once at startup)
_frequency_params = None

def _generate_frequency_parameters():
    """Generate random parameters for all frequency bands."""
    global _frequency_params
    if _frequency_params is not None:
        return _frequency_params
    
    rng = random.Random(42)  # Fixed seed for consistent world generation
    params = []
    
    # Generate parameters for each frequency band
    wavelength_range = MAX_WAVELENGTH_MULT - MIN_WAVELENGTH_MULT
    for i in range(NUM_FREQUENCIES):
        # Logarithmic wavelength distribution for better coverage
        wavelength_mult = MIN_WAVELENGTH_MULT + wavelength_range * (i / (NUM_FREQUENCIES - 1)) ** 2
        wavelength = wavelength_mult * BASE_ROOM_SIZE
        frequency = 1.0 / wavelength  # Convert wavelength to frequency
        
        # Random amplitude and phase for x and y directions
        amplitude = rng.uniform(0.3, 1.0)  # Amplitude of this frequency component
        phase_x = rng.uniform(0, 2 * math.pi)  # Phase offset for x direction
        phase_y = rng.uniform(0, 2 * math.pi)  # Phase offset for y direction
        
        params.append({
            'frequency': frequency,
            'wavelength': wavelength,  # Store for debugging
            'amplitude': amplitude,
            'phase_x': phase_x,
            'phase_y': phase_y
        })
    
    _frequency_params = params
    return params

def _calculate_spatial_variation(chunk_x: int, chunk_y: int) -> float:
    """Calculate spatial variation value (-1 to 1) based on chunk coordinates."""
    params = _generate_frequency_parameters()
    
    # Convert chunk coordinates to world position
    world_x = chunk_x * CHUNK_SIZE
    world_y = chunk_y * CHUNK_SIZE
    
    # Combine all frequency components
    total_variation = 0.0
    for param in params:
        freq = param['frequency']
        amp = param['amplitude']
        
        # Calculate sine wave contribution for this frequency
        x_component = math.sin(world_x * freq + param['phase_x'])
        y_component = math.sin(world_y * freq + param['phase_y'])
        
        # Combine x and y components (could be additive, multiplicative, etc.)
        combined = (x_component + y_component) / 2
        total_variation += amp * combined
    
    # Normalize to approximately -1 to 1 range
    normalized = total_variation / NUM_FREQUENCIES
    return max(-1.0, min(1.0, normalized))

def _get_spatial_alpha_beta(chunk_x: int, chunk_y: int) -> Tuple[float, float]:
    """Get spatially-varying alpha and beta parameters for the given chunk."""
    variation = _calculate_spatial_variation(chunk_x, chunk_y)
    
    # Map variation (-1 to 1) to alpha/beta modulation
    # Positive variation -> favor larger rooms (increase alpha, decrease beta)
    # Negative variation -> favor smaller rooms (decrease alpha, increase beta)
    
    alpha_mod = variation * FREQUENCY_INFLUENCE
    beta_mod = -variation * FREQUENCY_INFLUENCE  # Opposite direction
    
    alpha = BASE_ALPHA + alpha_mod
    beta = BASE_BETA + beta_mod
    
    # Ensure parameters stay in reasonable range
    alpha = max(0.5, min(4.0, alpha))
    beta = max(0.5, min(4.0, beta))
    
    return alpha, beta


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


def _sample_room_size(rng: random.Random, chunk_size: int, alpha: float, beta: float) -> int:
    """
    Sample room size using spatially-varying beta distribution.
    
    Uses spatially-varying alpha and beta parameters to create regions with 
    different room size tendencies across the world.
    """
    # Sample from beta distribution (0 to 1) with spatial parameters
    beta_sample = rng.betavariate(alpha, beta)
    
    # Scale to room size range
    size_range = MAX_ROOM_SIZE - MIN_ROOM_SIZE
    scaled_size = MIN_ROOM_SIZE + beta_sample * size_range
    
    # Ensure we don't exceed chunk size (minus margin for walls)
    max_allowed = min(MAX_ROOM_SIZE, chunk_size - 2)
    
    return max(MIN_ROOM_SIZE, min(int(scaled_size), max_allowed))


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
        
        # Generate 1-2 guaranteed connection points, avoiding edges
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
        
        # Add additional corridor points with low probability
        for _ in range(MAX_ADDITIONAL_CORRIDORS):
            if rng.random() < ADDITIONAL_CORRIDOR_PROBABILITY:
                # Generate additional corridor point
                additional_point = rng.randint(margin, chunk_size - margin - 1)
                # Ensure it's not too close to existing points
                if all(abs(additional_point - existing) >= MIN_CORRIDOR_SPACING for existing in points):
                    points.append(additional_point)
        
        return sorted(points)
    
    return BoundaryConstraints(
        north=get_boundary_points(chunk_x, chunk_y, 'north'),
        south=get_boundary_points(chunk_x, chunk_y, 'south'),
        east=get_boundary_points(chunk_x, chunk_y, 'east'),
        west=get_boundary_points(chunk_x, chunk_y, 'west')
    )


class DungeonGenerator:
    def __init__(self, width: int, height: int, seed: int, boundary_constraints: BoundaryConstraints, chunk_x: int, chunk_y: int):
        self.width = width
        self.height = height
        self.chunk_x = chunk_x
        self.chunk_y = chunk_y
        self.rng = random.Random(seed)
        self.grid = [[WALL_CHAR for _ in range(width)] for _ in range(height)]
        self.rooms: List[Room] = []
        self.boundary_constraints = boundary_constraints
        self.boundary_points: List[Tuple[int, int]] = []
        self.timings = {}
        
        # Get spatial alpha/beta parameters for this chunk
        self.alpha, self.beta = _get_spatial_alpha_beta(chunk_x, chunk_y)
    
    def generate(self) -> Tuple[List[str], dict]:
        """Generate a complete dungeon with boundary constraints and return timing data."""
        start_time = time.time()
        
        t1 = time.time()
        self._create_boundary_corridors()
        self.timings['boundary_corridors'] = time.time() - t1
        
        t2 = time.time()
        self._generate_rooms()
        self.timings['room_generation'] = time.time() - t2
        
        t3 = time.time()
        self._create_room_floors()
        self.timings['room_floors'] = time.time() - t3
        
        t4 = time.time()
        self._connect_rooms_with_hallways()
        self.timings['room_hallways'] = time.time() - t4
        
        t5 = time.time()
        self._connect_to_boundary_points()
        self.timings['boundary_connections'] = time.time() - t5
        
        self.timings['total'] = time.time() - start_time
        
        return ["".join(row) for row in self.grid], self.timings
    
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
            # Use probabilistic room sizing with natural distribution
            width = _sample_room_size(self.rng, self.width, self.alpha, self.beta)
            height = _sample_room_size(self.rng, self.height, self.alpha, self.beta)
            
            # Allow rooms to touch boundaries - reduced margin
            margin = 1  # Reduced from 3 to allow boundary rooms
            x = self.rng.randint(margin, self.width - width - margin)
            y = self.rng.randint(margin, self.height - height - margin)
            
            new_room = Room(x, y, width, height)
            
            # Check if room intersects with existing rooms or blocks critical boundary corridors
            if (not any(new_room.intersects(room, padding=2) for room in self.rooms) and
                not self._room_blocks_boundary_corridors(new_room)):
                self.rooms.append(new_room)
                
                # If we generated a very large room, we might be done
                room_area = width * height
                chunk_area = self.width * self.height
                if room_area > chunk_area * 0.6:  # Room takes up >60% of chunk
                    break  # Don't try to fit more rooms
            
            attempts += 1
        
        # Adjust minimum rooms based on how much space is filled
        total_room_area = sum(room.width * room.height for room in self.rooms)
        chunk_area = self.width * self.height
        space_utilization = total_room_area / chunk_area
        
        # Only enforce minimum if we haven't filled much space
        if len(self.rooms) < min_rooms and space_utilization < 0.4:
            self._force_generate_rooms(min_rooms - len(self.rooms))

    def _room_blocks_boundary_corridors(self, room: Room) -> bool:
        """Check if a room would block access to boundary corridor points."""
        for bx, by in self.boundary_points:
            # More precise blocking check - only prevent rooms from covering the exact corridor point
            # and ensure at least 1 tile of access space around corridor points
            if (room.x - 1 <= bx <= room.x + room.width and
                room.y - 1 <= by <= room.y + room.height):
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
            
            # Check if there's a room adjacent to this boundary point
            adjacent_room = self._find_adjacent_room_to_boundary(bx, by)
            
            if adjacent_room:
                # Create a door directly through the boundary into the adjacent room
                self._create_boundary_door_to_room(bx, by, adjacent_room)
            else:
                # Create a connection from boundary point to closest room center
                self._create_hallway(closest_room.center, (bx, by))

    def _find_adjacent_room_to_boundary(self, bx: int, by: int) -> Room:
        """Find a room that's adjacent to the given boundary point."""
        for room in self.rooms:
            # Check if boundary point is adjacent to room
            # North boundary (by=0) - check if room is just below
            if by == 0 and room.y == 1 and room.x <= bx <= room.x + room.width - 1:
                return room
            # South boundary (by=height-1) - check if room is just above  
            elif by == self.height - 1 and room.y + room.height == self.height - 1 and room.x <= bx <= room.x + room.width - 1:
                return room
            # West boundary (bx=0) - check if room is just to the right
            elif bx == 0 and room.x == 1 and room.y <= by <= room.y + room.height - 1:
                return room
            # East boundary (bx=width-1) - check if room is just to the left
            elif bx == self.width - 1 and room.x + room.width == self.width - 1 and room.y <= by <= room.y + room.height - 1:
                return room
        return None

    def _create_boundary_door_to_room(self, bx: int, by: int, room: Room):
        """Create a door from boundary point directly into an adjacent room."""
        # The boundary point is already a floor tile
        # We need to ensure there's a floor tile inside the room at the connection point
        
        # North boundary - create floor tile just inside room
        if by == 0 and room.y == 1:
            if 0 <= bx < self.width:
                self.grid[1][bx] = FLOOR_CHAR  # Floor tile inside room
        # South boundary - create floor tile just inside room  
        elif by == self.height - 1 and room.y + room.height == self.height - 1:
            if 0 <= bx < self.width:
                self.grid[self.height - 2][bx] = FLOOR_CHAR  # Floor tile inside room
        # West boundary - create floor tile just inside room
        elif bx == 0 and room.x == 1:
            if 0 <= by < self.height:
                self.grid[by][1] = FLOOR_CHAR  # Floor tile inside room
        # East boundary - create floor tile just inside room
        elif bx == self.width - 1 and room.x + room.width == self.width - 1:
            if 0 <= by < self.height:
                self.grid[by][self.width - 2] = FLOOR_CHAR  # Floor tile inside room

    def _force_generate_rooms(self, count: int):
        """Force generate rooms in remaining space."""
        for _ in range(count):
            for _ in range(50):  # Try 50 times to place a room
                # Use same probabilistic sizing as main generation
                width = _sample_room_size(self.rng, self.width, self.alpha, self.beta)
                height = _sample_room_size(self.rng, self.height, self.alpha, self.beta)
                # Use same reduced margin as main generation
                margin = 1  # Allow rooms closer to boundaries
                x = self.rng.randint(margin, self.width - width - margin)
                y = self.rng.randint(margin, self.height - height - margin)
                
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


def generate_chunk(x: int, y: int) -> Tuple[List[str], dict]:
    """Generate a dungeon chunk with boundary constraints for seamless connectivity."""
    start_time = time.time()
    
    t1 = time.time()
    seed = _seed_from_coords(x, y)
    boundary_constraints = get_boundary_constraints(x, y, CHUNK_SIZE)
    setup_time = time.time() - t1
    
    t2 = time.time()
    generator = DungeonGenerator(CHUNK_SIZE, CHUNK_SIZE, seed, boundary_constraints, x, y)
    init_time = time.time() - t2
    
    chunk_data, generation_timings = generator.generate()
    
    # Combine all timing data
    timings = {
        'setup': setup_time,
        'init': init_time,
        **generation_timings,
        'total_with_overhead': time.time() - start_time
    }
    
    return chunk_data, timings


@api_router.get("/map")
async def get_map_chunk(
    x: int = Query(0, description="Chunk X coordinate"),
    y: int = Query(0, description="Chunk Y coordinate"),
    debug: bool = Query(False, description="Include debug information"),
):
    """Return procedurally generated dungeon chunk at given coordinates."""
    if abs(x) > 1_000_000 or abs(y) > 1_000_000:
        raise HTTPException(status_code=400, detail="Invalid chunk coordinates")
    
    start_time = time.time()
    chunk_data, timings = generate_chunk(x, y)
    end_time = time.time()
    
    if debug:
        # Include alpha and beta values for debug visualization
        alpha, beta = _get_spatial_alpha_beta(x, y)
        
        # Get wavelength info for debugging
        freq_params = _generate_frequency_parameters()
        wavelengths = [f"{p['wavelength']:.0f}" for p in freq_params]
        
        return {
            "data": chunk_data,
            "debug": {
                "alpha": round(alpha, 3),
                "beta": round(beta, 3),
                "spatial_variation": round(_calculate_spatial_variation(x, y), 3),
                "generation_time": round(end_time - start_time, 3),
                "wavelengths": wavelengths,  # Show actual wavelengths used
                "timings": {k: round(v * 1000, 2) for k, v in timings.items()}  # Convert to milliseconds
            }
        }
    
    return chunk_data


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