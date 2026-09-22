const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_TTL_MS = 10 * 60 * 1000;
class RoomManager {
  constructor(){ this.rooms = new Map(); this.quickWaiting = null; }
  code(){ let c=''; do { c=''; for(let i=0;i<5;i++) c+=ALPHABET[Math.floor(Math.random()*ALPHABET.length)]; } while(this.rooms.has(c)); return c; }
  create(socketId, isQuick=false){ const code=this.code(); const room={code,status:'waiting',createdAt:Date.now(),lastActivityAt:Date.now(),players:[socketId],ready:new Map(),isQuick}; this.rooms.set(code,room); return room; }
  join(code,socketId){ const room=this.rooms.get(String(code||'').toUpperCase()); if(!room) return {error:'ROOM_NOT_FOUND'}; if(room.players.includes(socketId)) return {room}; if(room.players.length>=2) return {error:'ROOM_FULL'}; room.players.push(socketId); room.status='selecting'; room.lastActivityAt=Date.now(); return {room}; }
  quick(socketId){
    if(this.quickWaiting){ const room=this.rooms.get(this.quickWaiting); if(room && room.players.length===1 && room.players[0]!==socketId){ this.quickWaiting=null; return this.join(room.code,socketId); } this.quickWaiting=null; }
    const room=this.create(socketId,true); this.quickWaiting=room.code; return {room,waiting:true};
  }
  get(code){ return this.rooms.get(code); }
  findBySocket(id){ for(const room of this.rooms.values()) if(room.players.includes(id)) return room; return null; }
  touch(room){ if(room) room.lastActivityAt=Date.now(); }
  leave(socketId){ const room=this.findBySocket(socketId); if(!room) return null; room.players=room.players.filter(id=>id!==socketId); room.ready.delete(socketId); room.lastActivityAt=Date.now(); if(this.quickWaiting===room.code) this.quickWaiting=null; if(room.players.length===0) this.rooms.delete(room.code); else room.status='waiting'; return room; }
  cleanup(){ const now=Date.now(); for(const [code,room] of this.rooms){ if(room.status!=='playing' && now-room.lastActivityAt>ROOM_TTL_MS){ this.rooms.delete(code); if(this.quickWaiting===code) this.quickWaiting=null; } } }
}
module.exports={RoomManager,ROOM_TTL_MS};
