export function createVisibleModuleRenderer({activePage,views}){
  const signatures=new Map();
  return (snapshot,health)=>{
    if(!snapshot)return;
    const page=activePage(),view=views[page];if(!view)return;
    const signature=JSON.stringify(view.select(snapshot,health));
    if(signatures.get(page)===signature)return;
    view.render(snapshot,health);signatures.set(page,signature);
  };
}
