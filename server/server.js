const path=require('path');
const http=require('http');
const express=require('express');
const {Server}=require('socket.io');
const {RoomManager}=require('./roomManager');
const PROJECT_ROOT=path.join(__dirname,'..');
const PORT=process.env.PORT||3000;
const app=express(); app.use(express.static(PROJECT_ROOT)); app.get('/healthz',(req,res)=>res.json({ok:true,uptime:process.uptime()}));
const server=http.createServer(app); const io=new Server(server,{cors:{origin:'*'}}); const rooms=new RoomManager();
setInterval(()=>rooms.cleanup(),60_000).unref();
function joinSocketRoom(socket,room){ socket.join(room.code); socket.data.roomCode=room.code; rooms.touch(room); }
function opponent(room,id){ return room.players.find(x=>x!==id)||null; }
function roomState(room){ return {code:room.code,status:room.status,playerCount:room.players.length}; }
io.on('connection',socket=>{
  socket.on('ping-check',(p,ack)=>ack?.({ok:true,echo:p,serverTime:Date.now()}));
  socket.on('room:create',(_,ack)=>{ rooms.leave(socket.id); const room=rooms.create(socket.id); joinSocketRoom(socket,room); ack?.({ok:true,...roomState(room)}); });
  socket.on('room:join',({code}={},ack)=>{ rooms.leave(socket.id); const r=rooms.join(code,socket.id); if(r.error) return ack?.({ok:false,error:r.error}); joinSocketRoom(socket,r.room); ack?.({ok:true,...roomState(r.room)}); io.to(r.room.code).emit('room:matched',roomState(r.room)); });
  socket.on('match:quick',(_,ack)=>{ rooms.leave(socket.id); const r=rooms.quick(socket.id); joinSocketRoom(socket,r.room); ack?.({ok:true,waiting:!!r.waiting,...roomState(r.room)}); if(!r.waiting) io.to(r.room.code).emit('room:matched',roomState(r.room)); });
  socket.on('room:leave',()=>{ const room=rooms.leave(socket.id); if(room){ socket.leave(room.code); socket.to(room.code).emit('opponent:left'); } socket.data.roomCode=null; });
  socket.on('player:character',({charIndex}={},ack)=>{ const room=rooms.findBySocket(socket.id); if(!room) return ack?.({ok:false}); room.ready.set(socket.id,{charIndex:Number(charIndex)||0}); rooms.touch(room); socket.to(room.code).emit('opponent:character',{charIndex:Number(charIndex)||0}); if(room.ready.size===2){ room.status='playing'; const startAt=Date.now()+1200; io.to(room.code).emit('match:start',{startAt}); } ack?.({ok:true}); });
  socket.on('game:snapshot',(data)=>{ const room=rooms.findBySocket(socket.id); if(!room) return; rooms.touch(room); socket.to(room.code).emit('opponent:snapshot',data); });
  socket.on('game:motion',(data)=>{ const room=rooms.findBySocket(socket.id); if(!room) return; rooms.touch(room); socket.to(room.code).emit('opponent:motion',data); });
  socket.on('game:skill',(data)=>{ const room=rooms.findBySocket(socket.id); if(!room) return; rooms.touch(room); socket.to(room.code).emit('opponent:skill',data); });
  socket.on('game:win',(data)=>{ const room=rooms.findBySocket(socket.id); if(!room) return; room.status='finished'; io.to(room.code).emit('match:finished',{winnerId:socket.id,...data}); });
  socket.on('rematch:request',()=>{ const room=rooms.findBySocket(socket.id); if(!room)return; room.ready.set(socket.id,{...(room.ready.get(socket.id)||{}),rematch:true}); socket.to(room.code).emit('rematch:requested'); const both=room.players.length===2&&room.players.every(id=>room.ready.get(id)?.rematch); if(both){ room.ready.clear(); room.status='selecting'; io.to(room.code).emit('rematch:start'); } });
  socket.on('disconnect',()=>{ const room=rooms.leave(socket.id); if(room) socket.to(room.code).emit('opponent:left'); });
});
server.listen(PORT,()=>console.log(`[DANGO SERVER] listening on ${PORT}`));
module.exports={app,server,io};
