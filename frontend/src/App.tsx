import React, { useEffect, useState, useCallback } from 'react';
import { useRef } from 'react';

const CHUNK_SIZE = 48;
const FONT_SIZE_PX = 24; // Back to working size
const CHAR_WIDTH_PX = Math.floor(FONT_SIZE_PX * 0.6); // Back to working calculation

type Chunk = string[]; // 48 lines of 48 chars

interface ChunkInfo {
  data: Chunk;
  fetchTime: number; // milliseconds
  fetchedAt: number; // timestamp
}

function chunkCoords(x: number, y: number): [number, number] {
  return [Math.floor(x / CHUNK_SIZE), Math.floor(y / CHUNK_SIZE)];
}

function chunkKey(cx: number, cy: number): string {
  return `${cx},${cy}`;
}

async function fetchChunk(cx: number, cy: number): Promise<{ data: Chunk; fetchTime: number }> {
  const startTime = performance.now();
  const res = await fetch(`/api/map?x=${cx}&y=${cy}`);
  const data = await res.json();
  const fetchTime = performance.now() - startTime;
  return { data, fetchTime };
}

function useViewport(): { cols: number; rows: number } {
  const [dims, setDims] = useState(() => {
    // Use documentElement.clientWidth/Height to get viewport without scrollbars
    const availableWidth = document.documentElement.clientWidth || window.innerWidth;
    const availableHeight = document.documentElement.clientHeight || window.innerHeight;
    
    // Calculate character counts - be more efficient with space
    let cols = Math.floor(availableWidth / CHAR_WIDTH_PX);
    let rows = Math.floor(availableHeight / FONT_SIZE_PX);
    
    // Ensure odd numbers so there's always a center character
    if (cols % 2 === 0) cols -= 1;
    if (rows % 2 === 0) rows -= 1;
    
    return { cols, rows };
  });

  useEffect(() => {
    function onResize() {
      const availableWidth = document.documentElement.clientWidth || window.innerWidth;
      const availableHeight = document.documentElement.clientHeight || window.innerHeight;
      
      let cols = Math.floor(availableWidth / CHAR_WIDTH_PX);
      let rows = Math.floor(availableHeight / FONT_SIZE_PX);
      
      // Ensure odd numbers so there's always a center character
      if (cols % 2 === 0) cols -= 1;
      if (rows % 2 === 0) rows -= 1;
      
      setDims({ cols, rows });
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return dims;
}

interface ChunkCache {
  [key: string]: ChunkInfo;
}

const App: React.FC = () => {
  const [tileX, setTileX] = useState(8);
  const [tileY, setTileY] = useState(8);
  const [debugMode, setDebugMode] = useState(false);
  const viewport = useViewport();

  const [cache, setCache] = useState<ChunkCache>({});

  // Ensure required chunks are loaded whenever player moves or viewport changes
  useEffect(() => {
    const halfCols = Math.floor(viewport.cols / 2);
    const halfRows = Math.floor(viewport.rows / 2);

    const neededChunks = new Set<string>();

    for (let y = -halfRows; y <= halfRows; y++) {
      for (let x = -halfCols; x <= halfCols; x++) {
        const globalX = tileX + x;
        const globalY = tileY + y;
        const [cx, cy] = chunkCoords(globalX, globalY);
        neededChunks.add(chunkKey(cx, cy));
      }
    }

    // Fetch missing chunks
    neededChunks.forEach((key) => {
      if (!(key in cache)) {
        const [cxStr, cyStr] = key.split(',');
        const cx = parseInt(cxStr, 10);
        const cy = parseInt(cyStr, 10);
        fetchChunk(cx, cy).then(({ data, fetchTime }) => {
          setCache((prev) => ({ 
            ...prev, 
            [key]: { 
              data, 
              fetchTime, 
              fetchedAt: Date.now() 
            } 
          }));
        });
      }
    });
  }, [tileX, tileY, viewport, cache]);

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      // Check for Ctrl+D to toggle debug mode
      if (e.ctrlKey && e.key === 'd') {
        e.preventDefault();
        setDebugMode(prev => !prev);
        return;
      }

      switch (e.key) {
        case 'ArrowUp':
        case 'w':
          setTileY((y) => y - 1);
          break;
        case 'ArrowDown':
        case 's':
          setTileY((y) => y + 1);
          break;
        case 'ArrowLeft':
        case 'a':
          setTileX((x) => x - 1);
          break;
        case 'ArrowRight':
        case 'd':
          setTileX((x) => x + 1);
          break;
        case 'i':
          window.open('/api/readme', '_blank');
          break;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Build viewport data for regular mode
  if (!debugMode) {
    const lines: string[] = [];
    const halfCols = Math.floor(viewport.cols / 2);
    const halfRows = Math.floor(viewport.rows / 2);

    // Debug: log viewport dimensions
    console.log('Viewport:', {
      cols: viewport.cols,
      rows: viewport.rows,
      halfCols,
      halfRows,
      centerCol: halfCols,
      centerRow: halfRows,
      totalCols: halfCols * 2 + 1,
      totalRows: halfRows * 2 + 1
    });

    for (let row = -halfRows; row <= halfRows; row++) {
      let line = '';
      for (let col = -halfCols; col <= halfCols; col++) {
        const globalX = tileX + col;
        const globalY = tileY + row;
        const [cx, cy] = chunkCoords(globalX, globalY);
        const key = chunkKey(cx, cy);
        const chunkInfo = cache[key];
        let ch = ' ';
        if (chunkInfo) {
          const localX = ((globalX % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
          const localY = ((globalY % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
          ch = chunkInfo.data[localY]?.[localX] ?? ' ';
        }
        if (row === 0 && col === 0) {
          ch = '@';
        }
        line += ch;
      }
      lines.push(line);
    }

    return (
      <div style={{ position: 'relative' }}>
        <pre
          style={{
            lineHeight: 1,
            fontSize: FONT_SIZE_PX,
            color: '#0f0',
            margin: 0,
            padding: 0,
            position: 'absolute',
            top: 0,
            left: 0,
            fontFamily: "'Courier New', 'Lucida Console', monospace",
            fontWeight: 'normal',
            letterSpacing: 0,
            transform: 'scaleX(1.67)', // Only keep the square scaling
            transformOrigin: 'center center', // Center the transform
          }}
        >
          {lines.join('\n')}
        </pre>
        <div style={{
          position: 'fixed',
          top: 10,
          left: 10,
          color: '#0f0',
          fontSize: '12px',
          backgroundColor: 'rgba(0,0,0,0.7)',
          padding: '5px',
          borderRadius: '3px',
        }}>
          Press Ctrl+D for debug mode
        </div>
      </div>
    );
  }

  // Debug mode rendering
  const halfCols = Math.floor(viewport.cols / 2);
  const halfRows = Math.floor(viewport.rows / 2);
  
  // Build the same character grid as normal mode for consistent rendering
  const lines: string[] = [];
  const chunkInfoMap = new Map<string, { cx: number; cy: number; info: ChunkInfo | undefined }>();

  for (let row = -halfRows; row <= halfRows; row++) {
    let line = '';
    for (let col = -halfCols; col <= halfCols; col++) {
      const globalX = tileX + col;
      const globalY = tileY + row;
      const [cx, cy] = chunkCoords(globalX, globalY);
      const key = chunkKey(cx, cy);
      const chunkInfo = cache[key];
      
      // Store chunk info for overlay rendering
      if (!chunkInfoMap.has(key)) {
        chunkInfoMap.set(key, { cx, cy, info: chunkInfo });
      }
      
      let ch = ' ';
      if (chunkInfo) {
        const localX = ((globalX % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
        const localY = ((globalY % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
        ch = chunkInfo.data[localY]?.[localX] ?? ' ';
      }
      if (row === 0 && col === 0) {
        ch = '@';
      }
      line += ch;
    }
    lines.push(line);
  }

  return (
    <div style={{ position: 'relative', width: '100vw', height: '100vh', overflow: 'hidden' }}>
      {/* Render the main game content - same as normal mode */}
      <pre
        style={{
          lineHeight: 1,
          fontSize: FONT_SIZE_PX,
          color: '#0f0',
          margin: 0,
          padding: 0,
          position: 'absolute',
          top: 0,
          left: 0,
          fontFamily: "'Courier New', 'Lucida Console', monospace",
          fontWeight: 'normal',
          letterSpacing: 0,
          transform: 'scaleX(1.67)', // Only keep the square scaling
          transformOrigin: 'center center', // Center the transform
        }}
      >
        {lines.join('\n')}
      </pre>
      
      {/* Render chunk borders and info overlays */}
      {Array.from(chunkInfoMap.entries()).map(([key, { cx, cy, info }]) => {
        // Calculate the screen position of the chunk's top-left corner
        const chunkStartX = cx * CHUNK_SIZE;
        const chunkStartY = cy * CHUNK_SIZE;
        
        // Find the screen position relative to the player
        const relativeX = chunkStartX - tileX;
        const relativeY = chunkStartY - tileY;
        
        // Convert to screen coordinates - account for scaleX transform and center origin
        const baseScreenX = (relativeX + halfCols) * CHAR_WIDTH_PX;
        const baseScreenY = (relativeY + halfRows) * FONT_SIZE_PX;
        
        // Account for center-origin scaling: the transform expands from center
        const totalWidth = viewport.cols * CHAR_WIDTH_PX;
        const scalingOffset = (totalWidth * (1.67 - 1)) / 2; // How much the left edge shifts due to center scaling
        
        const screenX = baseScreenX * 1.67 - scalingOffset;
        const screenY = baseScreenY;
        
        const chunkWidth = CHUNK_SIZE * CHAR_WIDTH_PX * 1.67;
        const chunkHeight = CHUNK_SIZE * FONT_SIZE_PX;

        // Only render if the chunk is visible on screen
        if (screenX >= -chunkWidth && screenX <= window.innerWidth && 
            screenY >= -chunkHeight && screenY <= window.innerHeight) {
          
          return (
            <div key={key}>
              {/* Chunk border */}
              <div
                style={{
                  position: 'absolute',
                  left: screenX,
                  top: screenY,
                  width: chunkWidth,
                  height: chunkHeight,
                  border: '1px solid #ff0',
                  backgroundColor: 'rgba(255, 255, 0, 0.05)',
                  pointerEvents: 'none',
                  boxSizing: 'border-box',
                }}
              />
              
              {/* Debug info overlay - positioned at top-right of chunk to avoid content overlap */}
              <div
                style={{
                  position: 'absolute',
                  left: screenX + chunkWidth - 60 * 1.67,
                  top: screenY + 2,
                  fontSize: '8px',
                  color: '#ff0',
                  backgroundColor: 'rgba(0,0,0,0.9)',
                  padding: '1px 3px',
                  borderRadius: '2px',
                  lineHeight: 1.1,
                  pointerEvents: 'none',
                  fontFamily: 'monospace',
                  whiteSpace: 'nowrap',
                }}
              >
                <div>{cx},{cy}</div>
                {info ? (
                  <>
                    <div>{info.fetchTime.toFixed(0)}ms</div>
                    <div>{((Date.now() - info.fetchedAt) / 1000).toFixed(0)}s</div>
                  </>
                ) : (
                  <div>...</div>
                )}
              </div>
            </div>
          );
        }
        return null;
      })}
      
      {/* Debug info panel */}
      <div style={{
        position: 'fixed',
        top: 10,
        left: 10,
        color: '#0f0',
        fontSize: '12px',
        backgroundColor: 'rgba(0,0,0,0.9)',
        padding: '8px',
        borderRadius: '4px',
        border: '1px solid #0f0',
        fontFamily: 'monospace',
      }}>
        <div><strong>DEBUG MODE</strong></div>
        <div>Ctrl+D to exit</div>
        <div>Player: {tileX}, {tileY}</div>
        <div>Chunks: {chunkInfoMap.size}</div>
        <div>Cached: {Object.keys(cache).length}</div>
      </div>
    </div>
  );
};

export default App; 