import { quoteArg } from './job-title.js';

/**
 * Update golden's reason, outside its field (components/UpdateReason.tsx): the job's field for it,
 * and a command with it. No DOM here, so a page that only starts the job carries no dialog's parts.
 */

/** The job's field for it; none where nothing was typed. */
export const reasonField = (reason: string): { reason?: string } => (reason ? { reason } : {});

/** A command with the reason as its update takes it; the command as it is where it updates nothing, or nothing was typed. */
export const withReason = (command: string, reason: string): string => (reason && /(^| )--update( |$)/.test(command) ? `${command} --reason ${quoteArg(reason)}` : command);
