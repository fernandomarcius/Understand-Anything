import { Controller, Get, Post, Param } from '@nestjs/common'

@Controller('cats')
export class CatsController {
  @Get(':id')
  findOne(@Param('id') id: string) {
    return id
  }

  @Post()
  create() {
    return {}
  }
}
