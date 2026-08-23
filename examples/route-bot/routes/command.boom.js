/**
 * /boom — demonstrates the error boundary chain.
 *   /boom       → unexpected error: generic ephemeral + ops alert
 *   /boom user  → UserError: friendly message, no alert
 */

import { UserError } from '../../../lib/index.js';

export default async function boom({ payload }) {
  if (payload.text === 'user') {
    throw new UserError('You asked for a friendly error, here it is.');
  }
  throw new Error('Deliberate unexpected failure');
}
