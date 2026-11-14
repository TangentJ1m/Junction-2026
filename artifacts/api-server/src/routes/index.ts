import { Router, type IRouter } from "express";
import healthRouter from "./health";
import butlerRouter from "./butler";

const router: IRouter = Router();

router.use(healthRouter);
router.use(butlerRouter);

export default router;
