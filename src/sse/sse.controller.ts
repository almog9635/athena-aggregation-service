import {
  Controller,
  Get,
  Req,
  Query,
  Res,
  UsePipes,
  ValidationPipe,
  BadRequestException,
  Param,
} from '@nestjs/common';
import express from 'express';
import { SseService } from './sse.service';
import { MockDataService } from './providers/mock-data.service';
import { EventsQueryDto } from './dto/events-query.dto';
import { ChangeRangeDto } from './dto/change-range.dto';

interface RequestWithUser extends express.Request {
  userId?: string;
}

@Controller('sse')
export class SseController {
  constructor(
    private readonly sseService: SseService,
    private readonly mockDataService: MockDataService,
  ) {}

  @Get('events')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  async events(
    @Req() req: RequestWithUser,
    @Res() res: express.Response,
    @Query() query: EventsQueryDto,
  ) {
    try {
      const userId = query.userId;
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

  @Get('entity/:id/details')
  async getEntityDetails(@Param('id') id: string) {
    const details = this.mockDataService.getExtraDetails(id);
    if (!details) {
      throw new BadRequestException(`Entity with ID ${id} not found`);
    }
    return details;
  }
}
