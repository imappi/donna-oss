// GB opening-balance routing owns its existing ask kind and writer dependencies.
import { isGbOpeningBalanceAsk, resolveGbOpeningBalanceInbound } from './openingBalanceRoute.js';
export const COUNTRY_INBOUND_ADAPTER = Object.freeze({
  jurisdiction: 'gb', replies: Object.freeze([]),
  opening: Object.freeze({ matches: (ask) => isGbOpeningBalanceAsk(ask),
    flagReaderKey: 'gbOpeningBalanceFlagActs', resolverKey: 'resolveGbOpeningBalanceInbound',
    createAskKey: 'createGbOpeningBalanceAsk', postKey: 'postGbOpeningBalanceJournal',
    resolve: (args) => resolveGbOpeningBalanceInbound(args) })
});
