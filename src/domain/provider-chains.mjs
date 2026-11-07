/** Common chains shown by diagnostic pickers. The AVE session accepts other safe EVM chain slugs too. */
export const AVE_SUPPORTED_CHAINS=Object.freeze(['eth','bsc','base','arbitrum','optimism','polygon','sol','robinhood','xlayer','avalanche','monad','giwa']);
export const AVE_EVM_ROUTES=Object.freeze(AVE_SUPPORTED_CHAINS.filter((chain)=>chain!=='sol'));
export function isAveChainSlug(value){
  const chain=String(value??'').trim().toLowerCase();
  return chain==='sol'||chain==='solana'||/^[a-z0-9][a-z0-9_-]{0,31}$/.test(chain);
}
