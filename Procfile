# Heroku process definitions
registry: node component-system/registry/simple-registry.js
node-daemon: node component-system/daemon/simple-daemon.js
rust-daemon: ./component-system/daemon/rust/component-daemon/target/release/component-daemon
html-renderer: node -e "require('http').createServer((req,res)=>{ if(req.url==='/'||req.url==='/index.html'){ require('fs').createReadStream('component-system/renderer/html/index.html').pipe(res); } else { res.writeHead(404); res.end('Not found'); } }).listen(process.env.PORT||8080);"
