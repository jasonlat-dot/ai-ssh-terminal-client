type Anchor = {left:number;right:number;top:number;bottom:number};

/** Prefer the side of the sidebar, then flip or move below on small windows. */
export function historyPreviewPosition(anchor:Anchor,card:{width:number;height:number},viewport:{width:number;height:number}) {
 const edge=12,gap=10;
 const clamp=(value:number,size:number,limit:number)=>Math.max(edge,Math.min(value,Math.max(edge,limit-size-edge)));
 let left:number,top=anchor.top-4;
 if(anchor.right+gap+card.width<=viewport.width-edge)left=anchor.right+gap;
 else if(anchor.left-gap-card.width>=edge)left=anchor.left-gap-card.width;
 else {left=clamp(anchor.left,card.width,viewport.width);top=anchor.bottom+gap;
  if(top+card.height>viewport.height-edge)top=anchor.top-gap-card.height;
 }
 return {left:clamp(left,card.width,viewport.width),top:clamp(top,card.height,viewport.height)};
}

/** Native session creation time is Unix seconds, not a last-activity timestamp. */
export function historyPreviewTime(createdAt:number,now=Date.now()) {
 const date=new Date(createdAt*1000);
 if(!Number.isFinite(createdAt)||createdAt<=0||Number.isNaN(date.getTime()))return null;
 const minutes=Math.floor((now-date.getTime())/60000);
 const label=minutes<0||minutes>=30*24*60?date.toLocaleDateString('zh-CN')
  :minutes<1?'刚刚':minutes<60?`${minutes} 分钟前`:minutes<1440?`${Math.floor(minutes/60)} 小时前`:`${Math.floor(minutes/1440)} 天前`;
 return {label,iso:date.toISOString(),full:'创建于 '+date.toLocaleString('zh-CN')};
}
