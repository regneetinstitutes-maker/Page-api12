import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import usersRouter from "./users";
import walletRouter from "./wallet";
import depositsRouter from "./deposits";
import paymentsRouter from "./payments";
import bankAccountsRouter from "./bank-accounts";
import withdrawalsRouter from "./withdrawals";
import competitionsRouter from "./competitions";
import operationsRouter from "./operations";
import notificationsRouter from "./notifications";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(usersRouter);
router.use(walletRouter);
router.use(depositsRouter);
router.use(paymentsRouter);
router.use(bankAccountsRouter);
router.use(withdrawalsRouter);
router.use(competitionsRouter);
router.use(operationsRouter);
router.use(notificationsRouter);

export default router;
