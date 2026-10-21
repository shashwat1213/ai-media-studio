// One-off: stop a scene that violates the content policy (FAILED + refund of its last charge).
import { PrismaClient } from '@prisma/client';
import { failAndRefund } from '../src/modules/director/scenes.routes.js';

const prisma = new PrismaClient();
const id = process.argv[2]!;
const refunded = await failAndRefund(prisma, id, 'This scene was stopped: sexual or nude content is not allowed. Your credits were refunded.');
const s = await prisma.scene.findUniqueOrThrow({ where: { id }, select: { status: true, error: true } });
console.log({ id, refunded, ...s });
await prisma.$disconnect();
