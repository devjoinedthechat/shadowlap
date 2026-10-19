// An agent that reads a uuid through the SDK, cuts a ticket's ref from it and files the ticket with a
// write tool. A pack that masked the uuid it read would hand the agent "<REDACTED>" on replay, the
// ticket would carry another ref, and the replay would part from the recording at the write.
import { tool, uuid } from '@shadowlap/sdk';

const createTicket = tool('create_ticket', { effect: 'write' }, async (args) => ({ ok: true, ref: args.ref }));
const id = await uuid();
const ticket = await createTicket({ ref: `T-${id.slice(0, 8)}`, subject: 'refund for order 4417' });
console.log('ticket', JSON.stringify(ticket));
