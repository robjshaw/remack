/** Submission handler for the /modal demo — validates and closes or errors. */

import { view } from '../../../lib/index.js';

export default async function demoSubmitted({ payload, defer, client, userId }) {
  const name = payload.view.state.values.name_block.name.value;

  if (!name || name.length < 2) {
    return view.errors({ name_block: 'Give me at least 2 characters.' });
  }

  defer(async () => {
    const dm = await client.conversations.open({ users: userId });
    await client.chat.postMessage({ channel: dm.channel.id, text: `Nice to meet you, ${name}!` });
  });
  // undefined → empty 200 → modal closes
}
