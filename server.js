var express = require('express');
var http = require('http');
var path = require('path');

var app = express();
var sessionStore = require('./lib/session-store');

app.use(express.raw({ type: 'application/octet-stream', limit: '500mb' }));
app.use(require('./routes/api'));
app.use('/d3.min.js', express.static(path.join(__dirname, 'node_modules/d3/dist/d3.min.js')));
app.use(express.static(path.join(__dirname, 'public')));

var server = http.createServer(app);
require('./lib/ws-server').attach(server, sessionStore);

var port = process.env.PORT || 3000;
server.listen(port, function() {
  console.log('Server listening on http://localhost:' + port);
});
