export let suggest_followup = {
  parameters: {
    type: 'object',
    properties: {
      slashslug: { type: 'string', description: `Single-word slug for this follow-up; MUST be prefixed with /` },
      followup: { type: 'string', description: `Follow-up suggestion the user can ask you back` },
    },
    required: ['slashslug', 'followup'],
  },
  handler: props => {
    kittyst.once('beforeprompt', () => console.log(`${props.slashslug} for: ${props.followup}`));
  },
};
