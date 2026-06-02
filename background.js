chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if(!msg || msg.type !== 'FETCH_URL') return;
  (async()=>{
    try{
      const r = await fetch(msg.url, {
        method:'GET',
        cache:'no-store',
        redirect:'follow',
        credentials:'include',
        headers:{
          'Accept': msg.asText ? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' : 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
        }
      });
      const contentType = r.headers.get('content-type') || '';
      if(!r.ok) throw new Error('HTTP '+r.status);
      if(msg.asText){
        const text = await r.text();
        sendResponse({ok:true, status:r.status, contentType, text});
      }else{
        const buf = await r.arrayBuffer();
        let binary='';
        const bytes = new Uint8Array(buf);
        const chunk = 0x8000;
        for(let i=0;i<bytes.length;i+=chunk){
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i+chunk));
        }
        sendResponse({ok:true, status:r.status, contentType, base64:btoa(binary)});
      }
    }catch(e){
      sendResponse({ok:false, error:e.message || String(e)});
    }
  })();
  return true;
});
