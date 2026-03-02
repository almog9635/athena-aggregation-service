import {
  Controller,
  Get,
  Post,
  Query,
  Body,
  Req,
  Res,
  UsePipes,
  ValidationPipe,
  BadRequestException,
} from '@nestjs/common';
import express from 'express';
import { SseService } from './sse.service';
import { EventsQueryDto } from './dto/events-query.dto';
import { ChangeRangeDto } from './dto/change-range.dto';

interface RequestWithUser extends express.Request {
  user?: { id?: string };
}

@Controller('sse')
export class SseController {
  constructor(private readonly sseService: SseService) {}

  @Get('events')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  async events(
    @Req() req: RequestWithUser,
    @Res() res: express.Response,
    @Query() query: EventsQueryDto,
  ) {
    try {
      const userId = req.user?.id;
      if (!userId) {
        // missing user id is an error
        throw new BadRequestException('userId is required');
      }
      await this.sseService.handleConnection(res, userId, query);
    } catch (err) {
      // pipes handle validation errors; service or our check may throw
      if (err instanceof BadRequestException) {
        res.status(400).json({ message: err.message });
      } else {
        const errorMessage =
          err instanceof Error ? err.message : 'unknown error';
        res.status(400).json({ message: errorMessage });
      }
    }
  }

  @Post('change-range')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  async changeRange(@Body() dto: ChangeRangeDto) {
    try {
      await this.sseService.changeRange(dto);
      return { ok: true };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'unknown error';
      throw new BadRequestException(errorMessage);
    }
  }
}
