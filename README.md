# Multi-Room Word Game Server

A real-time multiplayer word game server built with Node.js, Express, and Socket.IO.

## Project Structure

The codebase has been refactored into a modular structure for better maintainability:

```
src/
├── config/           # Configuration files
│   ├── timers.js     # Timer configuration and duration calculations
│   ├── messages.js   # Game messages and delay configurations
│   └── bot.js        # Bot configuration and management
├── utils/            # Utility functions
│   └── wordUtils.js  # Word processing and normalization utilities
├── data/             # Data management
│   └── wordBank.js   # Word bank loading and caching
├── game/             # Game logic
│   ├── roomManager.js # Room creation, lifecycle, and management
│   └── gameLogic.js  # Game flow, rounds, turns, and voting
├── socket/           # Socket.IO event handlers
│   └── handlers.js   # All socket event handlers
└── server.js         # Main server file
```

## Features

- **Multi-room support**: Multiple games can run simultaneously
- **Real-time gameplay**: Uses Socket.IO for instant communication
- **Word validation**: Validates words against theme-specific word banks
- **Voting system**: Players can vote against invalid words
- **Timer system**: Decreasing time limits as the game progresses
- **Bot support**: Automatic bot players for solo testing
- **Room management**: Automatic cleanup of inactive rooms

## Installation

1. Install dependencies:
```bash
npm install
```

2. Start the server:
```bash
npm start
```

The server will start on `http://localhost:3000` (or the port specified in the `PORT` environment variable).

## Configuration

### Timers (`src/config/timers.js`)
- Configure turn durations for different game levels
- Adjust vote duration settings

### Messages (`src/config/messages.js`)
- Customize game messages and notifications
- Set delay timings for popups and transitions

### Bot (`src/config/bot.js`)
- Configure bot behavior and response timing
- Adjust bot difficulty settings

## Game Rules

1. Players join a room with a code
2. The host starts the game when ready
3. Each round has a random theme
4. Players must submit words related to the theme
5. Duplicate words eliminate all players who submitted them
6. Players can vote against words they think are invalid
7. The game continues until one player remains or level 20 is reached

## Data Files

Word banks are stored in the `data/` directory as text files:
- Each file corresponds to a theme
- One word per line
- Comments start with `#`
- Files are automatically cached for performance

## Development

To add new features:

1. **New themes**: Add theme names to the `themes` array in `roomManager.js` and create corresponding word bank files
2. **New game mechanics**: Extend the game logic in `gameLogic.js`
3. **New socket events**: Add handlers in `handlers.js` and register them in `server.js`
4. **Configuration changes**: Modify the appropriate files in `config/`

## Architecture Benefits

- **Separation of concerns**: Each module has a specific responsibility
- **Maintainability**: Easier to find and modify specific functionality
- **Testability**: Individual modules can be tested in isolation
- **Scalability**: New features can be added without affecting existing code
- **Readability**: Clear structure makes the codebase easier to understand
