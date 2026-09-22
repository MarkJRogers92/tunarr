import { channelQuery } from '@/hooks/useChannels';
import ChannelWatchPage from '@/pages/watch/ChannelWatchPage';
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod/v4';

export const watchPageSearchSchema = z.object({
  noAutoPlay: z
    .union([z.boolean(), z.string().transform((s) => s === 'true')])
    .catch(false),
});

export const Route = createFileRoute('/channels_/$channelId/watch')({
  validateSearch: (s) => watchPageSearchSchema.parse(s),
  loader: ({ params: { channelId }, context: { queryClient } }) =>
    queryClient.ensureQueryData(channelQuery(channelId)),
  component: ChannelWatchPage,
});
