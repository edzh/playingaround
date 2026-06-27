'use strict';

// MongoDB LeafyGreen palette — exact tokens from @leafygreen-ui/palette.
// Single source of truth for every canvas/SVG/DOM color in the app.
window.LG = (function() {
  const palette = {
    black: '#001E2B',
    white: '#FFFFFF',
    gray:   { dark4:'#112733', dark3:'#1C2D38', dark2:'#3D4F58', dark1:'#5C6C75', base:'#889397', light1:'#C1C7C6', light2:'#E8EDEB', light3:'#F9FBFA' },
    green:  { dark3:'#023430', dark2:'#00684A', dark1:'#00A35C', base:'#00ED64', light1:'#71F6BA', light2:'#C0FAE6', light3:'#E3FCF7' },
    blue:   { dark3:'#0C2657', dark2:'#083C90', dark1:'#1254B7', base:'#016BF8', light1:'#0498EC', light2:'#C3E7FE', light3:'#E1F7FF' },
    purple: { dark3:'#2D0B59', dark2:'#5E0C9E', base:'#B45AF2', light2:'#F1D4FD', light3:'#F9EBFF' },
    yellow: { dark3:'#4C2100', dark2:'#944F01', base:'#FFC010', light2:'#FFEC9E', light3:'#FEF7DB' },
    red:    { dark3:'#5B0000', dark2:'#970606', base:'#DB3030', light1:'#FF6960', light2:'#FFCDC7', light3:'#FFEAE5' },
  };

  // Semantic surfaces (dark mode)
  const semantic = {
    bg:          palette.black,
    surface:     palette.gray.dark4,
    surface2:    palette.gray.dark3,
    border:      palette.gray.dark2,
    borderMuted: palette.gray.dark3,
    text:        palette.gray.light2,
    text2:       palette.gray.light1,
    text3:       palette.gray.base,
    accent:      palette.green.base,
    accentDim:   palette.green.dark1,
    link:        palette.blue.light1,
  };

  // Health states → { border, text, bg } using LeafyGreen tokens.
  // On dark backgrounds LeafyGreen uses the lighter red shade for legibility.
  const health = {
    GREEN:  { border: palette.green.base,  text: palette.green.light1,  bg: palette.green.dark3 },
    YELLOW: { border: palette.yellow.base, text: palette.yellow.light2, bg: palette.yellow.dark3 },
    RED:    { border: palette.red.light1,  text: palette.red.light1,    bg: palette.red.dark3 },
  };

  // Cluster role badges
  const role = {
    mongos:     { txt:'MONGOS',  bg: palette.blue.base,   fg: palette.white },
    shardsvr:   { txt:'SHARD',   bg: palette.green.dark2, fg: palette.green.base },
    configsvr:  { txt:'CONFIG',  bg: palette.gray.dark2,  fg: palette.gray.light1 },
    replset:    { txt:'REPLSET', bg: palette.green.dark2, fg: palette.green.base },
    standalone: { txt:'MONGOD',  bg: palette.gray.dark2,  fg: palette.gray.light1 },
  };

  // Distinct hues for shard segments / accents (bright — dark text sits on top)
  const series = [palette.green.base, palette.blue.light1, palette.purple.base, palette.yellow.base, palette.green.light1, palette.blue.light2];

  // Flow colors for edges + particles
  const flow = {
    ops:    palette.blue.light1,   // client→cache op flow
    evict:  palette.yellow.base,   // cache→disk eviction
    read:   palette.green.base,    // disk→cache read path
    repl:   palette.purple.base,   // replication / oplog
    info:   palette.gray.base,     // low-signal metadata edges
  };

  return { palette, semantic, health, role, series, flow };
})();
