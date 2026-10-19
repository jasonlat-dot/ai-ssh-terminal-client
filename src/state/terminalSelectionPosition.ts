type Rect = {left:number;right:number;top:number;bottom:number};
type Range = {start:{x:number;y:number};end:{x:number;y:number}};

/** Installed xterm returns zero-based buffer cells, with an exclusive end. */
export function terminalSelectionBounds(range:Range|undefined,viewportY:number,rows:number,cols:number,screen:Rect):Rect|null {
  if(!range||rows<=0||cols<=0||screen.bottom<=screen.top||screen.right<=screen.left)return null;
  const lastRow=range.end.y-(range.end.x===0?1:0);
  const first=Math.max(range.start.y,viewportY),last=Math.min(lastRow,viewportY+rows-1);
  if(last<first)return null;
  const rowHeight=(screen.bottom-screen.top)/rows,cellWidth=(screen.right-screen.left)/cols;
  const singleRow=range.start.y===lastRow;
  const left=screen.left+(singleRow?range.start.x:0)*cellWidth;
  const endColumn=range.end.x===0?cols:range.end.x;
  return {left,right:singleRow?screen.left+endColumn*cellWidth:screen.right,
    top:screen.top+(first-viewportY)*rowHeight,bottom:screen.top+(last-viewportY+1)*rowHeight};
}

/** Prefer the space above the selected rows; clamp to the visible window. */
export function terminalSelectionActionPosition(anchor:Rect,card:{width:number;height:number},viewport:{width:number;height:number}) {
  const edge=8,gap=8;
  const clamp=(value:number,size:number,limit:number)=>Math.max(edge,Math.min(value,Math.max(edge,limit-size-edge)));
  const left=clamp((anchor.left+anchor.right-card.width)/2,card.width,viewport.width);
  const above=anchor.top-gap-card.height;
  return {left,top:clamp(above>=edge?above:anchor.bottom+gap,card.height,viewport.height)};
}
