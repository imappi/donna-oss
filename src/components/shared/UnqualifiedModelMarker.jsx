// "unqualified local model" — shown next to a decision a self-hosted,
// unqualified model made (src/lib/unqualifiedModel.js). Renders nothing
// otherwise, so every screen without such a seat is unchanged.
import { FormattedMessage } from 'react-intl';

import { isUnqualifiedLocalDecision } from '../../lib/unqualifiedModel.js';

export const UnqualifiedModelMarker = ({ decision, style = null, messageId = 'mounted.model.unqualifiedLocal' }) => (isUnqualifiedLocalDecision(decision) ? (
  <span
    data-unqualified-model="true"
    style={{
      display: 'inline-block',
      marginInlineStart: 6,
      padding: '0 5px',
      borderRadius: 4,
      border: '1px solid currentColor',
      fontSize: 10.5,
      fontWeight: 600,
      lineHeight: '15px',
      whiteSpace: 'nowrap',
      ...(style || {})
    }}
  >
    <FormattedMessage id={messageId} />
  </span>
) : null);
