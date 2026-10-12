import { join } from 'path';
import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';

import { JOURNAL_LEDGER } from '@application/ports/journal-ledger.port';
import { GrpcJournalLedger } from './grpc-journal-ledger';
import { JOURNAL_LEDGER_CLIENT } from './journal-grpc.constants';
import { platformGrpcAddress } from './staff-grpc.constants';
import { platformChannelOptions } from './channel-options';

/**
 * Wires the journal ledger port to its gRPC adapter.
 *
 * Same server and port as the directories (platform-api:50052, or
 * gostyle_api:50052 in the Swarm stack -- never the short name `api`, which
 * inside this stack is booking-api itself). No credentials: like the
 * directories, it is reachable only on gostyle-net.
 *
 * THIS MODULE IS THE ONLY PLACE THE TWO MEET.
 */
@Module({
  imports: [
    ClientsModule.register([
      {
        name: JOURNAL_LEDGER_CLIENT,
        transport: Transport.GRPC,
        options: {
          // Must match the `package` line in journal.proto exactly.
          package: 'gostyle.journal.v1',
          protoPath: join(process.cwd(), 'proto/journal.proto'),
          url: platformGrpcAddress(),
          channelOptions: platformChannelOptions(),
          loader: {
            // keepCase: true is NOT optional -- see services-grpc.module.ts.
            keepCase: true,
            // `replayed: false` arrives as false, an empty list as [].
            defaults: true,
            // Number, NOT String as in the sibling modules: the report's two
            // totals are int64 and would otherwise arrive as strings.
            longs: Number,
            enums: String,
            oneofs: true,
          },
        },
      },
    ]),
  ],
  providers: [{ provide: JOURNAL_LEDGER, useClass: GrpcJournalLedger }],
  exports: [JOURNAL_LEDGER],
})
export class JournalGrpcModule {}
