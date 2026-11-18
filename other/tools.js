export let track_topic = {
  parameters: {
    type: 'object',
    properties: { topic: { type: 'string' } },
    required: ['topic'],
  },
  handler: ({ topic }) => console.log(`Topic changed:`, topic),
};
