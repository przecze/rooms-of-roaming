import React, { useEffect, useState, useCallback } from 'react';
import { useRef } from 'react';
import Dialog from './components/Dialog';

const CHUNK_SIZE = 48;
const FONT_SIZE_PX = 24; // Back to working size
const CHAR_WIDTH_PX = Math.floor(FONT_SIZE_PX * 0.6); // Back to working calculation
const MOVEMENT_DELAY = 300; // 300ms delay between moves

type Chunk = string[]; // 48 lines of 48 chars

interface ChunkInfo {
  data: Chunk;
  fetchTime: number; // milliseconds
  fetchedAt: number; // timestamp
  debug?: {
    alpha: number;
    beta: number;
    spatial_variation: number;
    generation_time: number;
    wavelengths: string[];
    timings: {
      setup: number;
      init: number;
      boundary_corridors: number;
      room_generation: number;
      room_floors: number;
      room_hallways: number;
      boundary_connections: number;
      total: number;
      total_with_overhead: number;
    };
  };
}

interface PlayerSession {
  session_id: string;
  current_x: number;
  current_y: number;
  chalk_points: number;
  max_distance_reached: number;
}

interface Tablet {
  id: number;
  local_x: number;
  local_y: number;
  content: string;
  last_updated?: string;
}

function chunkCoords(x: number, y: number): [number, number] {
  return [Math.floor(x / CHUNK_SIZE), Math.floor(y / CHUNK_SIZE)];
}

function chunkKey(cx: number, cy: number): string {
  return `${cx},${cy}`;
}

async function fetchChunk(cx: number, cy: number, debug: boolean = false): Promise<{ data: Chunk; fetchTime: number; debug?: any }> {
  const startTime = performance.now();
  const url = debug ? `/api/map?x=${cx}&y=${cy}&debug=true` : `/api/map?x=${cx}&y=${cy}`;
  const res = await fetch(url);
  const response = await res.json();
  const fetchTime = performance.now() - startTime;
  
  if (debug && response.data) {
    return { 
      data: response.data, 
      fetchTime,
      debug: response.debug
    };
  }
  
  return { data: response, fetchTime };
}

async function createSession(): Promise<PlayerSession | null> {
  try {
    const res = await fetch('/api/session', { method: 'POST' });
    const data = await res.json();
    return data.session_id ? data : null;
  } catch (error) {
    console.warn('Failed to create session:', error);
    return null;
  }
}

async function updatePlayerPosition(sessionId: string, x: number, y: number): Promise<PlayerSession | null> {
  try {
    const res = await fetch(`/api/session/${sessionId}/move?x=${x}&y=${y}`, { method: 'POST' });
    const data = await res.json();
    return data.session_id ? data : null;
  } catch (error) {
    console.warn('Failed to update position:', error);
    return null;
  }
}

async function getChunkTablets(chunkX: number, chunkY: number): Promise<Tablet[]> {
  try {
    const res = await fetch(`/api/tablet/${chunkX}/${chunkY}`);
    const data = await res.json();
    return data.tablets || [];
  } catch (error) {
    console.warn('Failed to fetch tablets:', error);
    return [];
  }
}

async function writeToTablet(tabletId: number, content: string, sessionId: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/tablet/${tabletId}/write?content=${encodeURIComponent(content)}&session_id=${sessionId}`, { method: 'POST' });
    return res.ok;
  } catch (error) {
    console.warn('Failed to write to tablet:', error);
    return false;
  }
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
  const [showLanding, setShowLanding] = useState(true);
  const [animationOffset, setAnimationOffset] = useState({ x: 0, y: 0 });
  const [session, setSession] = useState<PlayerSession | null>(null);
  const [showTabletDialog, setShowTabletDialog] = useState(false);
  const [currentTablet, setCurrentTablet] = useState<Tablet | null>(null);
  const [tabletContent, setTabletContent] = useState('');
  const [canMove, setCanMove] = useState(true);
  const [tablets, setTablets] = useState<Map<string, Tablet[]>>(new Map());
  const viewport = useViewport();

  const [cache, setCache] = useState<ChunkCache>({});
  const lastMoveTime = useRef<number>(0);

  // Create session when app starts
  useEffect(() => {
    createSession().then(sessionData => {
      if (sessionData && sessionData.session_id) {
        setSession(sessionData);
      }
    });
  }, []);

  // Movement with delay and API calls
  const movePlayer = useCallback((newX: number, newY: number) => {
    const now = Date.now();
    
    // Skip delay in debug mode
    if (!debugMode && (now - lastMoveTime.current < MOVEMENT_DELAY || !canMove)) {
      return; // Ignore rapid movements
    }
    
    lastMoveTime.current = now;
    setCanMove(false);
    
    setTileX(newX);
    setTileY(newY);
    
    // Update server with new position
    if (session?.session_id) {
      updatePlayerPosition(session.session_id, newX, newY).then(updatedSession => {
        if (updatedSession) {
          setSession(updatedSession);
        }
      });
    }
    
    // Re-enable movement after delay (or immediately in debug mode)
    setTimeout(() => setCanMove(true), debugMode ? 50 : MOVEMENT_DELAY);
  }, [session, canMove, debugMode]);

  // Check for tablet at current position
  useEffect(() => {
    if (showLanding) return;
    
    const [chunkX, chunkY] = chunkCoords(tileX, tileY);
    const localX = ((tileX % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const localY = ((tileY % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    
    const chunkKey = `${chunkX},${chunkY}`;
    const chunkTablets = tablets.get(chunkKey) || [];
    
    // Debug logging
    if (debugMode) {
      console.log(`Player at (${tileX}, ${tileY}) -> chunk (${chunkX}, ${chunkY}) local (${localX}, ${localY})`);
      console.log(`Tablets in chunk:`, chunkTablets);
    }
    
    const tabletAtPosition = chunkTablets.find((t: Tablet) => t.local_x === localX && t.local_y === localY);
    
    if (tabletAtPosition && !showTabletDialog) {
      console.log('Found tablet at position:', tabletAtPosition);
      setCurrentTablet(tabletAtPosition);
      setTabletContent(tabletAtPosition.content);
      setShowTabletDialog(true);
    }
  }, [tileX, tileY, tablets, showTabletDialog, showLanding, debugMode]);

  // Load tablets for visible chunks
  useEffect(() => {
    if (showLanding) return;
    
    const halfCols = Math.floor(viewport.cols / 2);
    const halfRows = Math.floor(viewport.rows / 2);
    const visibleChunks = new Set<string>();

    for (let y = -halfRows; y <= halfRows; y++) {
      for (let x = -halfCols; x <= halfCols; x++) {
        const globalX = tileX + x;
        const globalY = tileY + y;
        const [cx, cy] = chunkCoords(globalX, globalY);
        visibleChunks.add(`${cx},${cy}`);
      }
    }

    visibleChunks.forEach(key => {
      if (!tablets.has(key)) {
        const [cx, cy] = key.split(',').map(Number);
        getChunkTablets(cx, cy).then(chunkTablets => {
          if (debugMode) {
            console.log(`Loaded ${chunkTablets.length} tablets for chunk ${key}:`, chunkTablets);
          }
          setTablets((prev: Map<string, Tablet[]>) => new Map(prev).set(key, chunkTablets));
        });
      }
    });
  }, [tileX, tileY, viewport, tablets, showLanding, debugMode]);

  // Floating animation for landing page
  useEffect(() => {
    if (!showLanding) return;

    const animate = () => {
      const time = Date.now() / 4000; // Faster for more noticeable movement
      setAnimationOffset({
        x: Math.sin(time) * 8,           // Increased from 3 to 8
        y: Math.cos(time * 0.6) * 6      // Increased from 2 to 6, slower Y movement
      });
    };

    const interval = setInterval(animate, 100); // Update more frequently
    return () => clearInterval(interval);
  }, [showLanding]);

  // Use animated position in landing mode, player position in game mode
  const centerX = showLanding ? Math.floor(tileX + animationOffset.x) : tileX;
  const centerY = showLanding ? Math.floor(tileY + animationOffset.y) : tileY;

  // Shared chunk loading system
  useEffect(() => {
    const halfCols = Math.floor(viewport.cols / 2);
    const halfRows = Math.floor(viewport.rows / 2);
    const neededChunks = new Set<string>();

    for (let y = -halfRows; y <= halfRows; y++) {
      for (let x = -halfCols; x <= halfCols; x++) {
        const globalX = centerX + x;
        const globalY = centerY + y;
        const [cx, cy] = chunkCoords(globalX, globalY);
        neededChunks.add(chunkKey(cx, cy));
      }
    }

    neededChunks.forEach((key) => {
      if (!(key in cache)) {
        const [cxStr, cyStr] = key.split(',');
        const cx = parseInt(cxStr, 10);
        const cy = parseInt(cyStr, 10);
        fetchChunk(cx, cy, debugMode).then(({ data, fetchTime, debug }) => {
          setCache((prev) => ({ 
            ...prev, 
            [key]: { 
              data, 
              fetchTime, 
              fetchedAt: Date.now(),
              debug 
            } 
          }));
        });
      }
    });
  }, [centerX, centerY, viewport, cache, debugMode]);

  // Keyboard controls (only active when not in landing mode)
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (showLanding) {
        // Landing page controls
        if (e.key === 'Enter') {
          e.preventDefault();
          setShowLanding(false);
        }
        return;
      }

      // Game controls (only active when not in landing mode)
      if (e.ctrlKey && e.key === 'd') {
        e.preventDefault();
        setDebugMode(prev => {
          setCache({});
          setTablets(new Map()); // Clear tablet cache too
          return !prev;
        });
        return;
      }

      switch (e.key) {
        case 'ArrowUp':
        case 'w':
          movePlayer(tileX, tileY - 1);
          break;
        case 'ArrowDown':
        case 's':
          movePlayer(tileX, tileY + 1);
          break;
        case 'ArrowLeft':
        case 'a':
          movePlayer(tileX - 1, tileY);
          break;
        case 'ArrowRight':
        case 'd':
          movePlayer(tileX + 1, tileY);
          break;
        case 'i':
          window.open('/api/readme', '_blank');
          break;
        case 'Escape':
          if (showTabletDialog) {
            setShowTabletDialog(false);
            setCurrentTablet(null);
          }
          break;
        case 't':
          // Manual tablet detection for testing
          if (debugMode) {
            const [chunkX, chunkY] = chunkCoords(tileX, tileY);
            const localX = ((tileX % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
            const localY = ((tileY % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
            const chunkKey = `${chunkX},${chunkY}`;
            const chunkTablets = tablets.get(chunkKey) || [];
            
            console.log('Manual tablet check:');
            console.log(`Position: (${tileX}, ${tileY})`);
            console.log(`Chunk: (${chunkX}, ${chunkY})`);
            console.log(`Local: (${localX}, ${localY})`);
            console.log(`Tablets in chunk:`, chunkTablets);
            
            const tabletAtPosition = chunkTablets.find((t: Tablet) => t.local_x === localX && t.local_y === localY);
            if (tabletAtPosition) {
              console.log('Found tablet:', tabletAtPosition);
              setCurrentTablet(tabletAtPosition);
              setTabletContent(tabletAtPosition.content);
              setShowTabletDialog(true);
            } else {
              console.log('No tablet at this position');
            }
          }
          break;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [showLanding, movePlayer, tileX, tileY, showTabletDialog]);

  // Build maze view (shared between landing and game)
  const buildMazeView = () => {
    const lines: string[] = [];
    const halfCols = Math.floor(viewport.cols / 2);
    const halfRows = Math.floor(viewport.rows / 2);

    for (let row = -halfRows; row <= halfRows; row++) {
      let line = '';
      for (let col = -halfCols; col <= halfCols; col++) {
        const globalX = centerX + col;
        const globalY = centerY + row;
        const [cx, cy] = chunkCoords(globalX, globalY);
        const key = chunkKey(cx, cy);
        const chunkInfo = cache[key];
        
        let ch = ' ';
        if (chunkInfo) {
          const localX = ((globalX % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
          const localY = ((globalY % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
          ch = chunkInfo.data[localY]?.[localX] ?? ' ';
        }
        
        // Show player only in game mode
        if (row === 0 && col === 0 && !showLanding) {
          ch = '@';
        }
        line += ch;
      }
      lines.push(line);
    }
    return lines;
  };

  const lines = buildMazeView();

  // Debug: Check if maze is rendering
  console.log('Landing mode:', showLanding, 'Lines count:', lines.length, 'First line sample:', lines[0]?.substring(0, 10));

  // Debug mode rendering
  if (!showLanding && debugMode) {
    const halfCols = Math.floor(viewport.cols / 2);
    const halfRows = Math.floor(viewport.rows / 2);
    const chunkInfoMap = new Map<string, { cx: number; cy: number; info: ChunkInfo | undefined }>();

    // Collect chunk info for debug overlays
    for (let row = -halfRows; row <= halfRows; row++) {
      for (let col = -halfCols; col <= halfCols; col++) {
        const globalX = tileX + col;
        const globalY = tileY + row;
        const [cx, cy] = chunkCoords(globalX, globalY);
        const key = chunkKey(cx, cy);
        const chunkInfo = cache[key];
        
        if (!chunkInfoMap.has(key)) {
          chunkInfoMap.set(key, { cx, cy, info: chunkInfo });
        }
      }
    }

    return (
      <div style={{ position: 'relative', width: '100vw', height: '100vh', overflow: 'hidden' }}>
        {/* Maze content */}
        <pre style={{
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
          transform: 'scaleX(1.67)',
          transformOrigin: 'center center',
        }}>
          {lines.join('\n')}
        </pre>
        
        {/* Debug overlays */}
        {Array.from(chunkInfoMap.entries()).map(([key, { cx, cy, info }]) => {
          const chunkStartX = cx * CHUNK_SIZE;
          const chunkStartY = cy * CHUNK_SIZE;
          const relativeX = chunkStartX - tileX;
          const relativeY = chunkStartY - tileY;
          const baseScreenX = (relativeX + halfCols) * CHAR_WIDTH_PX;
          const baseScreenY = (relativeY + halfRows) * FONT_SIZE_PX;
          const totalWidth = viewport.cols * CHAR_WIDTH_PX;
          const scalingOffset = (totalWidth * (1.67 - 1)) / 2;
          const screenX = baseScreenX * 1.67 - scalingOffset;
          const screenY = baseScreenY;
          const chunkWidth = CHUNK_SIZE * CHAR_WIDTH_PX * 1.67;
          const chunkHeight = CHUNK_SIZE * FONT_SIZE_PX;

          if (screenX >= -chunkWidth && screenX <= window.innerWidth && 
              screenY >= -chunkHeight && screenY <= window.innerHeight) {
            return (
              <div key={key}>
                <div style={{
                  position: 'absolute',
                  left: screenX,
                  top: screenY,
                  width: chunkWidth,
                  height: chunkHeight,
                  border: '1px solid #ff0',
                  backgroundColor: 'rgba(255, 255, 0, 0.05)',
                  pointerEvents: 'none',
                  boxSizing: 'border-box',
                }} />
                
                <div style={{
                  position: 'absolute',
                  left: screenX + chunkWidth - 120 * 1.67,
                  top: screenY + 2,
                  fontSize: '12px',
                  color: '#ff0',
                  backgroundColor: 'rgba(0,0,0,0.95)',
                  padding: '6px 8px',
                  borderRadius: '4px',
                  lineHeight: 1.1,
                  pointerEvents: 'none',
                  fontFamily: 'monospace',
                  whiteSpace: 'nowrap',
                  border: '1px solid #ff0',
                }}>
                  <div style={{ fontWeight: 'bold' }}>{cx},{cy}</div>
                  {info ? (
                    <>
                      <div>Fetch: {info.fetchTime.toFixed(0)}ms</div>
                      <div>Age: {((Date.now() - info.fetchedAt) / 1000).toFixed(0)}s</div>
                      {info.debug && (
                        <>
                          <div>α:{info.debug.alpha} β:{info.debug.beta}</div>
                          <div>Var: {info.debug.spatial_variation}</div>
                          <div style={{ marginTop: '2px', fontSize: '11px' }}>
                            <div>Setup: {info.debug.timings.setup}ms</div>
                            <div>Init: {info.debug.timings.init}ms</div>
                            <div>Bound: {info.debug.timings.boundary_corridors}ms</div>
                            <div>Rooms: {info.debug.timings.room_generation}ms</div>
                            <div>Floors: {info.debug.timings.room_floors}ms</div>
                            <div>Halls: {info.debug.timings.room_hallways}ms</div>
                            <div>Conn: {info.debug.timings.boundary_connections}ms</div>
                            <div style={{ fontWeight: 'bold', borderTop: '1px solid #ff0', paddingTop: '1px' }}>
                              Total: {info.debug.timings.total}ms
                            </div>
                          </div>
                        </>
                      )}
                    </>
                  ) : (
                    <div>Loading...</div>
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
          fontSize: '14px',
          backgroundColor: 'rgba(0,0,0,0.9)',
          padding: '10px',
          borderRadius: '4px',
          border: '1px solid #0f0',
          fontFamily: 'monospace',
        }}>
          <div><strong>DEBUG MODE</strong></div>
          <div>Ctrl+D to exit</div>
          <div>Player: {tileX}, {tileY}</div>
          <div>Chunks: {chunkInfoMap.size}</div>
          <div>Cached: {Object.keys(cache).length}</div>
          {(() => {
            const chunkWithDebug = Object.values(cache).find(chunk => chunk.debug?.wavelengths);
            if (chunkWithDebug?.debug?.wavelengths) {
              return (
                <div style={{ marginTop: '4px', fontSize: '12px' }}>
                  <div>Wavelengths:</div>
                  <div>{chunkWithDebug.debug.wavelengths.join(', ')}</div>
                </div>
              );
            }
            return null;
          })()}
        </div>
      </div>
    );
  }

  // Main render - normal game or landing page
  return (
    <div style={{ position: 'relative', width: '100vw', height: '100vh', overflow: 'hidden' }}>
      {/* Maze layer - identical rendering for both modes */}
      <pre style={{
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
        transform: 'scaleX(1.67)',
        transformOrigin: 'center center',
      }}>
        {lines.join('\n')}
      </pre>
      
      {/* Landing page splash dialog */}
      <Dialog isOpen={showLanding} onClose={() => setShowLanding(false)}>
        <div style={{
          fontSize: '3rem',
          fontWeight: 'bold',
          marginBottom: '2rem',
          textShadow: '0 0 20px #0f0',
          letterSpacing: '0.1em',
        }}>
          THE ROOMS OF<br />ROAMING
        </div>
        <button
          onClick={() => setShowLanding(false)}
          style={{
            fontSize: '1.5rem',
            padding: '1rem 2rem',
            backgroundColor: 'transparent',
            border: '2px solid #0f0',
            color: '#0f0',
            fontFamily: "'Courier New', 'Lucida Console', monospace",
            cursor: 'pointer',
            borderRadius: '0',
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
            transition: 'all 0.3s ease',
          }}
          onMouseEnter={(e) => {
            e.target.style.backgroundColor = '#0f0';
            e.target.style.color = '#000';
          }}
          onMouseLeave={(e) => {
            e.target.style.backgroundColor = 'transparent';
            e.target.style.color = '#0f0';
          }}
        >
          Start Exploring
        </button>
      </Dialog>

      {/* Game mode HUD */}
      {!showLanding && (
        <div style={{
          position: 'fixed',
          top: 10,
          left: 10,
          color: '#0f0',
          fontSize: '12px',
          backgroundColor: 'rgba(0,0,0,0.7)',
          padding: '8px',
          borderRadius: '3px',
          fontFamily: "'Courier New', 'Lucida Console', monospace",
        }}>
          {session && (
            <div style={{ marginBottom: '4px', fontSize: '14px', fontWeight: 'bold' }}>
              ◊ Chalk Points: {session.chalk_points}
            </div>
          )}
          <div>Press Ctrl+D for debug mode</div>
          <div>Step on ◊ to interact with tablets</div>
          {debugMode && (
            <div style={{ marginTop: '4px', color: '#ff0' }}>
              DEBUG: Fast movement enabled<br/>
              Position: ({tileX}, {tileY})<br/>
              Press 't' to manually check tablet
            </div>
          )}
        </div>
      )}

      {/* Tablet Dialog */}
      <Dialog isOpen={showTabletDialog} onClose={() => {
        setShowTabletDialog(false);
        setCurrentTablet(null);
      }}>
        {currentTablet && (
          <div style={{
            maxWidth: '600px',
            color: '#0f0',
            fontFamily: "'Courier New', 'Lucida Console', monospace",
          }}>
            <div style={{
              fontSize: '1.5rem',
              fontWeight: 'bold',
              marginBottom: '1rem',
              textAlign: 'center',
              textShadow: '0 0 10px #0f0',
            }}>
              ◊ STONE TABLET ◊
            </div>
            
            <div style={{
              border: '1px solid #0f0',
              padding: '1rem',
              marginBottom: '1rem',
              backgroundColor: 'rgba(0,15,0,0.1)',
              minHeight: '200px',
              whiteSpace: 'pre-wrap',
              fontFamily: 'monospace',
              fontSize: '14px',
              lineHeight: '1.4',
            }}>
              {currentTablet.content || '[ Empty tablet - be the first to write something ]'}
            </div>

            <div style={{ marginBottom: '1rem' }}>
              <label style={{ display: 'block', marginBottom: '0.5rem' }}>
                Add your message (costs 1 chalk point per character):
              </label>
              <textarea
                value={tabletContent}
                onChange={(e) => setTabletContent(e.target.value)}
                style={{
                  width: '100%',
                  height: '100px',
                  backgroundColor: 'rgba(0,0,0,0.8)',
                  border: '1px solid #0f0',
                  color: '#0f0',
                  fontFamily: 'monospace',
                  fontSize: '14px',
                  padding: '8px',
                  resize: 'vertical',
                }}
                placeholder="Write your message here..."
              />
              <div style={{ 
                fontSize: '12px', 
                marginTop: '0.5rem',
                color: session && session.chalk_points >= (tabletContent.length - currentTablet.content.length) ? '#0f0' : '#f00'
              }}>
                Characters to add: {Math.max(0, tabletContent.length - currentTablet.content.length)} | 
                Chalk needed: {Math.max(0, tabletContent.length - currentTablet.content.length)} | 
                You have: {session?.chalk_points || 0}
              </div>
            </div>

            <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center' }}>
              <button
                onClick={async () => {
                  if (!session?.session_id || !currentTablet) return;
                  
                  const newContent = tabletContent.slice(currentTablet.content.length);
                  if (newContent.length === 0) {
                    setShowTabletDialog(false);
                    setCurrentTablet(null);
                    return;
                  }
                  
                  const success = await writeToTablet(currentTablet.id, newContent, session.session_id);
                  if (success) {
                    // Update the current tablet content
                    setCurrentTablet({...currentTablet, content: tabletContent});
                    // Refresh tablets cache
                    const [chunkX, chunkY] = chunkCoords(tileX, tileY);
                    const chunkKey = `${chunkX},${chunkY}`;
                    const updatedTablets = await getChunkTablets(chunkX, chunkY);
                    setTablets(prev => new Map(prev).set(chunkKey, updatedTablets));
                    // Update session (chalk points should be updated by the API)
                    if (session.session_id) {
                      updatePlayerPosition(session.session_id, tileX, tileY).then(updatedSession => {
                        if (updatedSession) {
                          setSession(updatedSession);
                        }
                      });
                    }
                    setShowTabletDialog(false);
                    setCurrentTablet(null);
                  } else {
                    alert('Failed to write to tablet. Check your chalk points.');
                  }
                }}
                disabled={!session || (tabletContent.length - currentTablet.content.length) > (session.chalk_points || 0) || tabletContent.length <= currentTablet.content.length}
                style={{
                  padding: '0.75rem 1.5rem',
                  backgroundColor: 'transparent',
                  border: '2px solid #0f0',
                  color: '#0f0',
                  fontFamily: "'Courier New', 'Lucida Console', monospace",
                  cursor: 'pointer',
                  fontSize: '14px',
                  opacity: (!session || (tabletContent.length - currentTablet.content.length) > (session.chalk_points || 0) || tabletContent.length <= currentTablet.content.length) ? 0.5 : 1,
                }}
              >
                Write to Tablet
              </button>
              
              <button
                onClick={() => {
                  setShowTabletDialog(false);
                  setCurrentTablet(null);
                }}
                style={{
                  padding: '0.75rem 1.5rem',
                  backgroundColor: 'transparent',
                  border: '2px solid #0f0',
                  color: '#0f0',
                  fontFamily: "'Courier New', 'Lucida Console', monospace",
                  cursor: 'pointer',
                  fontSize: '14px',
                }}
              >
                Close (ESC)
              </button>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
};

export default App; 