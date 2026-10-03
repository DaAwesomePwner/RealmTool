/**
 * RC4 keys for the two directions of a RotMG connection. This is the only copy in
 * the codebase; update it here when a game build changes them.
 */
export const RC4_KEYS = Object.freeze({
  /** Game → server: decrypts what the game sends and encrypts what we send upstream. */
  clientToServer: '5a4d2016bc16dc64883194ffd9',
  /** Server → game: decrypts what the server sends and encrypts what we send to the game. */
  serverToClient: 'c91d9eec420160730d825604e0',
});

/** The game-server TCP port Exalt connects to, and the port the proxy listens on. */
export const GAME_PORT = 2050;
/** Smallest legal frame: 4-byte length + 1-byte packet id. */
export const MIN_FRAME = 5;
/** Largest frame accepted from either side. */
export const MAX_FRAME = 1_048_576;
