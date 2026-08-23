export function loader() {
  return { greeting: 'hello' };
}

export function render({ data }) {
  return [{ type: 'section', text: { type: 'mrkdwn', text: data.greeting } }];
}
