import dayjs from 'dayjs';
import path from 'path';
import { childCommand } from 'child-command';
import { oneLine } from 'common-tags';
import { Processor, Process } from '@nestjs/bull';
import { mapSeries } from 'p-iteration';
import { Job } from 'bull';
import { Inject } from '@nestjs/common';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { EntityManager, Transaction, TransactionManager } from 'typeorm';
import { Logger } from 'winston';

import { LIBRARY_CONFIG } from 'src/config';

import {
  JobsQueue,
  FileType,
  DownloadableMediaState,
  OrganizeQueueProcessors,
  ParameterKey,
  OrganizeLibraryStrategy,
} from 'src/app.dto';

import allowedExtensions from 'src/utils/allowed-file-extensions.json';
import { formatNumber } from 'src/utils/format-number';

import { MovieDAO } from 'src/entities/dao/movie.dao';
import { TVSeasonDAO } from 'src/entities/dao/tvseason.dao';
import { TVEpisodeDAO } from 'src/entities/dao/tvepisode.dao';
import { TorrentDAO } from 'src/entities/dao/torrent.dao';

import { TransmissionService } from 'src/modules/transmission/transmission.service';
import { LibraryService } from 'src/modules/library/library.service';
import { ParamsService } from 'src/modules/params/params.service';
import { FileDAO } from 'src/entities/dao/file.dao';

@Processor(JobsQueue.RENAME_AND_LINK)
export class OrganizeProcessor {
  public constructor(
    @Inject(WINSTON_MODULE_PROVIDER) private logger: Logger,
    private readonly transmissionService: TransmissionService,
    private readonly libraryService: LibraryService,
    private readonly paramsService: ParamsService
  ) {
    this.logger = this.logger.child({ context: 'OrganizeProcessor' });
  }

  private getOrganizeStrategyCommand(strategy: OrganizeLibraryStrategy) {
    switch (strategy) {
      case OrganizeLibraryStrategy.LINK:
        return 'ln -s';
      case OrganizeLibraryStrategy.MOVE:
        return 'mv';
      case OrganizeLibraryStrategy.COPY:
        return 'cp -R';
      default: {
        throw new Error('unknown strategy');
      }
    }
  }

  private random(){
    return `${new Date().getTime()}-${Math.floor(Math.random() * 8999) + 1000}`;
  }

  private async run(command: string){
    this.logger.debug(command);
    await childCommand(command);
  }

  private async addToFilebotQueue(torrentName: string, folderName: string){
    // Filebot watch is sensitive to file creation times.
    // To make it happy, this method copies everything to a staging directory
    // first, then does a `move` on the whole directory which is fast.
    const libraryPath = `/usr/library/`;
    const torrentStage = path.resolve(libraryPath, "filebot/stage/", torrentName);
    const destination = path.resolve(torrentStage, this.random(), folderName);
    await this.run(`mkdir -p "${destination}"`);

    // Delete the directory after 15 minutes, if it's still there.
    await new Promise(r => setTimeout(r, 15*60*1000));
    await this.run(`rm -rf "${torrentStage}"`);
  }

  @Process(OrganizeQueueProcessors.HANDLE_MOVIE)
  @Transaction()
  public async renameAndLinkMovie(
    job: Job<{ movieId: number }>,
    @TransactionManager() manager?: EntityManager
  ) {
    const { movieId } = job.data;

    const movieDAO = manager!.getCustomRepository(MovieDAO);
    const torrentDAO = manager!.getCustomRepository(TorrentDAO);
    const fileDAO = manager!.getCustomRepository(FileDAO);

    const organizeStrategy = (await this.paramsService.get(
      ParameterKey.ORGANIZE_LIBRARY_STRATEGY
    )) as OrganizeLibraryStrategy;

    this.logger.info(`start rename and ${organizeStrategy} movie`, { movieId });

    const movie = await this.libraryService.getMovie(movieId);
    const torrent = await this.transmissionService.getResourceTorrent({
      resourceId: movie.id,
      resourceType: FileType.MOVIE,
    });

    const year = dayjs(movie.releaseDate).format('YYYY');
    const torrentName = torrent.transmissionTorrent.name;
    const folderName = `${movie.title} (${year})`;
    await this.addToFilebotQueue(torrentName, folderName);

    await movieDAO.save({
      id: movieId,
      state: DownloadableMediaState.DOWNLOADED,
    });

    this.logger.info('finish rename and link movie', { movieId });
  }

  @Process(OrganizeQueueProcessors.HANDLE_EPISODE)
  @Transaction()
  public async renameAndLinkEpisode(
    job: Job<{ episodeId: number }>,
    @TransactionManager() manager?: EntityManager
  ) {
    const { episodeId } = job.data;

    const tvEpisodeDAO = manager!.getCustomRepository(TVEpisodeDAO);
    const torrentDAO = manager!.getCustomRepository(TorrentDAO);
    const fileDAO = manager!.getCustomRepository(FileDAO);

    const organizeStrategy = (await this.paramsService.get(
      ParameterKey.ORGANIZE_LIBRARY_STRATEGY
    )) as OrganizeLibraryStrategy;

    this.logger.info(`start rename and ${organizeStrategy} episode`, {
      episodeId,
    });

    const episode = await tvEpisodeDAO.findOneOrFail({
      where: { id: episodeId },
      relations: ['season', 'season.tvShow'],
    });

    const tvShow = await this.libraryService.getTVShow(
      episode.season.tvShow.id,
      { language: 'en' }
    );

    const torrent = await this.transmissionService.getResourceTorrent({
      resourceId: episode.id,
      resourceType: FileType.EPISODE,
    });

    const torrentName = torrent.transmissionTorrent.name;
    const seasonNb = formatNumber(episode.season.seasonNumber);
    const folderName = `${tvShow.title}/Season ${seasonNb}`
    await this.addToFilebotQueue(torrentName, folderName);
    await tvEpisodeDAO.save({
      id: episode.id,
      state: DownloadableMediaState.DOWNLOADED,
    });

    this.logger.info('finish rename and link episode', { episodeId });
  }

  @Process(OrganizeQueueProcessors.HANDLE_SEASON)
  @Transaction()
  public async renameAndLinkSeason(
    job: Job<{ seasonId: number }>,
    @TransactionManager() manager?: EntityManager
  ) {
    const { seasonId } = job.data;

    const tvSeasonDAO = manager!.getCustomRepository(TVSeasonDAO);
    const tvEpisodeDAO = manager!.getCustomRepository(TVEpisodeDAO);
    const torrentDAO = manager!.getCustomRepository(TorrentDAO);
    const fileDAO = manager!.getCustomRepository(FileDAO);

    const organizeStrategy = (await this.paramsService.get(
      ParameterKey.ORGANIZE_LIBRARY_STRATEGY
    )) as OrganizeLibraryStrategy;

    this.logger.info(`start rename and ${organizeStrategy} season`, {
      seasonId,
    });

    const season = await tvSeasonDAO.findOneOrFail({
      where: { id: seasonId },
      relations: ['tvShow', 'episodes'],
    });

    const tvShow = await this.libraryService.getTVShow(season.tvShow.id, {
      language: 'en',
    });

    const torrent = await this.transmissionService.getResourceTorrent({
      resourceId: season.id,
      resourceType: FileType.SEASON,
    });

    const seasonNb = formatNumber(season.seasonNumber);
    const folderName = `${tvShow.title}/Season ${seasonNb}`
    const torrentName = torrent.transmissionTorrent.name;
    await this.addToFilebotQueue(torrentName, folderName);

    // set all episodes to downloaded
    await tvEpisodeDAO.save(
      season.episodes
        .map((episode) => ({
          id: episode.id,
          state: DownloadableMediaState.DOWNLOADED,
        }))
    );

    // set tvSeason as processed too
    await tvSeasonDAO.save({
      id: season.id,
      state: DownloadableMediaState.PROCESSED,
    });

    this.logger.info('finsh rename and link season', { seasonId });
  }
}
