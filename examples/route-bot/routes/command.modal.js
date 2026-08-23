/** /modal — opens a modal; its submission is handled by view.demo.js. */

export default async function openModal({ client, triggerId }) {
  await client.views.open({
    trigger_id: triggerId,
    view: {
      type: 'modal',
      callback_id: 'demo',
      title: { type: 'plain_text', text: 'slackline demo' },
      submit: { type: 'plain_text', text: 'Submit' },
      blocks: [
        {
          type: 'input',
          block_id: 'name_block',
          label: { type: 'plain_text', text: 'Your name' },
          element: { type: 'plain_text_input', action_id: 'name' },
        },
      ],
    },
  });
}
