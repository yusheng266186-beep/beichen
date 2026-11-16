'use strict';

function workbuddyAccountBase(env=process.env){
 const value=env.WORKBUDDY_ACCOUNT_BASE_URL;
 if(typeof value!=='string')return null;
 try{
  const url=new URL(value);
  return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&!url.search&&!url.hash&&
   /^\d{6,}-[a-z0-9]+\.ap-chengdu\.tencentscf\.com$/.test(url.hostname)&&url.pathname==='/v1/workbench'?url.href:null;
 }catch{return null;}
}
module.exports={workbuddyAccountBase};
