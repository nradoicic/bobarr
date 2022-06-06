import dayjs from 'dayjs';
import axios from 'axios';
import xmlParser from 'xml2json-light';
import { orderBy, uniq, uniqBy } from 'lodash';
import { mapSeries } from 'p-iteration';
import { Injectable, Inject } from '@nestjs/common';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';

import { ParameterKey } from 'src/app.dto';
import { formatNumber } from 'src/utils/format-number';
import { sanitize } from 'src/utils/sanitize';

import { ParamsService } from 'src/modules/params/params.service';
import { LibraryService } from 'src/modules/library/library.service';

import { TVSeasonDAO } from 'src/entities/dao/tvseason.dao';
import { TVEpisodeDAO } from 'src/entities/dao/tvepisode.dao';
import { Quality } from 'src/entities/quality.entity';
import { Tag } from 'src/entities/tag.entity';

import { JackettResult, JackettIndexer } from './jackett.dto';
import { Entertainment } from '../tmdb/tmdb.dto';
import { PromiseRaceAll } from 'src/utils/promise-resolve';
import { JACKETT_RESPONSE_TIMEOUT } from 'src/config';

@Injectable()
export class JackettService {
  public constructor(
    @Inject(WINSTON_MODULE_PROVIDER) private logger: Logger,
    private readonly paramsService: ParamsService,
    private readonly libraryService: LibraryService,
    private readonly tvSeasonDAO: TVSeasonDAO,
    private readonly tvEpisodeDAO: TVEpisodeDAO
  ) {
    this.logger = logger.child({ context: 'JackettService' });
  }

  private async request<TData>(path: string, params: Record<string, any>) {
    const jackettApiKey = await this.paramsService.get(
      ParameterKey.JACKETT_API_KEY
    );

    const client = axios.create({
      baseURL: 'http://jackett:9117/api/v2.0/indexers/all',
      params: { apikey: jackettApiKey },
    });

    return client.get<TData>(path, { params });
  }

  private async xmlRequest<TData>(path: string, params: Record<string, any>) {
    const { data: xml } = await this.request(path, params);
    return xmlParser.xml2json(xml) as TData;
  }

  public async getConfiguredIndexers() {
    const { indexers } = await this.xmlRequest<{
      indexers: {
        indexer: JackettIndexer[] | JackettIndexer;
      };
    }>('/results/torznab', { t: 'indexers', configured: true });
    return Array.isArray(indexers.indexer)
      ? indexers.indexer
      : [indexers.indexer];
  }

  public async searchMovie(movieId: number) {
    this.logger.info('search movie', { movieId });

    const maxSize = await this.paramsService.getNumber(
      ParameterKey.MAX_MOVIE_DOWNLOAD_SIZE
    );

    const movie = await this.libraryService.getMovie(movieId);
    const year = dayjs(movie.releaseDate).format('YYYY');
    const queries = [`${movie.title} ${year}`];
    const translatedOriginal = this.toLatin(movie.originalTitle);
    if (this.isLatin(translatedOriginal)) {
      queries.push(`${translatedOriginal} ${year}`);
    }
    return this.search(queries, { maxSize, type: Entertainment.Movie });
  }

  public async searchSeason(seasonId: number) {
    this.logger.info('search tv season', { seasonId });

    const maxSize = await this.paramsService.getNumber(
      ParameterKey.MAX_TVSHOW_EPISODE_DOWNLOAD_SIZE
    );

    const tvSeason = await this.tvSeasonDAO.findOneOrFail({
      where: { id: seasonId },
      relations: ['tvShow', 'episodes'],
    });

    const tvShow = await this.libraryService.getTVShow(tvSeason.tvShow.id);
    const enTVShow = await this.libraryService.getTVShow(tvSeason.tvShow.id, {
      language: 'en',
    });

    const titles = [tvShow.title, enTVShow.title];
    const translatedOriginal = this.toLatin(tvShow.originalTitle);
    if (this.isLatin(translatedOriginal)) {
      titles.push(translatedOriginal);
    }

    const queries = uniq(titles)
      // support "American Dad!" like
      // TODO: Non-english words like "Sezona" should be generated based on the original language of the show.
      .map((title) => title.replace('!', ''))
      .map((title) => [
        `${title} S${tvSeason.seasonNumber}`,
        `${title} S${formatNumber(tvSeason.seasonNumber)}`,
        `${title} Season ${formatNumber(tvSeason.seasonNumber)}`,
        `${title} Sezona ${formatNumber(tvSeason.seasonNumber)}`, 
        `${title} Saison ${formatNumber(tvSeason.seasonNumber)}`,
        `${title} e01-e`,
      ])
      .flat();

    return this.search(queries, {
      maxSize: maxSize * tvSeason.episodes.length,
      isSeason: true,
      type: Entertainment.TvShow,
    });
  }

  public async searchEpisode(episodeId: number) {
    this.logger.info('search tv episode', { episodeId });

    const maxSize = await this.paramsService.getNumber(
      ParameterKey.MAX_TVSHOW_EPISODE_DOWNLOAD_SIZE
    );

    const tvEpisode = await this.tvEpisodeDAO.findOneOrFail({
      where: { id: episodeId },
      relations: ['tvShow'],
    });

    const tvShow = await this.libraryService.getTVShow(tvEpisode.tvShow.id);
    const enTVShow = await this.libraryService.getTVShow(tvEpisode.tvShow.id, {
      language: 'en',
    });

    const s = formatNumber(tvEpisode.seasonNumber);
    const e = formatNumber(tvEpisode.episodeNumber);

    const titles = [tvShow.title, enTVShow.title];
    const translatedOriginal = this.toLatin(tvShow.originalTitle);
    if (this.isLatin(translatedOriginal)) {
      titles.push(translatedOriginal);
    }

    const queries = uniq(titles)
      .map((title) => [
        `${title} S${s}E${e}`,
        `${title} S${tvEpisode.seasonNumber}E${e}`,
        `${title} S${s}.E${e}`,
        `${title} S${tvEpisode.seasonNumber}.E${e}`,
        `${title} Season ${s} Episode ${e}`,
        `${title} Saison ${s} Episode ${e}`,
      ])
      .flat();

    return this.search(queries, { maxSize, type: Entertainment.TvShow });
  }

  public async search(
    queries: string[],
    opts: {
      maxSize?: number;
      isSeason?: boolean;
      withoutFilter?: boolean;
      type?: Entertainment;
    }
  ) {
    const indexers = await this.getConfiguredIndexers();
    const noResultsError = 'NO_RESULTS';

    try {
      const allIndexers = indexers.map((indexer) =>
        this.searchIndexer({ ...opts, queries, indexer })
      );

      const resolvedIndexers = await PromiseRaceAll(
        allIndexers,
        opts.withoutFilter
          ? JACKETT_RESPONSE_TIMEOUT.manual
          : JACKETT_RESPONSE_TIMEOUT.automatic
      );
      const flattenIndexers = resolvedIndexers
        .filter((item) => Boolean(item))
        ?.flat();

      const sortedByBest = orderBy(
        flattenIndexers,
        ['indexer', 'tag.score', 'quality.score', 'seeders'],
        ['desc', 'desc', 'desc', 'desc']
      );

      return opts.withoutFilter ? sortedByBest : [sortedByBest[0]];
    } catch (error) {
      // return empty results array, let application continue it's lifecycle
      if (Array.isArray(error) && error[0].message === noResultsError) {
        return [];
      }

      // its a non handled error, throw
      // throw first non handled error from promises
      if (Array.isArray(error)) {
        throw error[0];
      }

      throw error;
    }
  }

  public async searchIndexer({
    queries,
    indexer,
    maxSize = Infinity,
    isSeason = false,
    withoutFilter = false,
    type,
  }: {
    queries: string[];
    indexer?: JackettIndexer;
    maxSize?: number;
    isSeason?: boolean;
    withoutFilter?: boolean;
    type?: Entertainment;
  }) {
    const qualityParams = await this.paramsService.getQualities(type);
    const preferredTags = await this.paramsService.getTags();

    const rawResults = await mapSeries(uniq(queries), async (query) => {
      // const normalizedQuery = sanitize(query);
      const normalizedQuery = query;
      this.logger.info('search torrents with query', {
        indexer: indexer?.title || 'all',
        query: normalizedQuery,
      });

      try {
        const { data } = await this.request<{ Results: JackettResult[] }>(
          '/results',
          {
            Query: normalizedQuery,
            Category: [2000, 5000, 5070],
            Tracker: indexer ? [indexer.id] : undefined,
            _: Number(new Date()),
          }
        );

        return data.Results;
      } catch (e) {
        return [];
      }
    });

    this.logger.info(`found ${rawResults.flat().length} potential results`);
    const results = uniqBy(rawResults.flat(), 'Guid')
      .filter((result) => result.Link || result.MagnetUri)
      .map((result) =>
        this.formatSearchResult({ result, qualityParams, preferredTags })
      )
      .filter((result) => {
        if (withoutFilter) return true;
        const hasAcceptableSize = result.size < maxSize;
        const hasSeeders = result.seeders >= 0 && result.seeders > result.peers;
        const hasTag = result.tag.score > 0;
        const isEpisode = result.normalizedTitleParts.some((titlePart) =>
          titlePart.match(/e\d+|episode|episode\d+|ep|ep\d+/) && !result.normalizedTitle.match(/ep?\d+\s*ep?\d+/)
        );
        this.logger.info(
          `${result.title}`,
          {hasAcceptableSize:hasAcceptableSize, hasSeeders:hasSeeders, hasTag:hasTag, isEpisode:isEpisode}
        )
        if (isSeason) {
          return hasAcceptableSize && hasSeeders && !isEpisode;
        } else {
          return hasAcceptableSize && hasSeeders && hasTag;
        }
      });

    this.logger.info(`found ${results.length} downloadable results`);

    return results;
  }

  private formatSearchResult = ({
    result,
    qualityParams,
    preferredTags,
  }: {
    result: JackettResult;
    qualityParams: Quality[];
    preferredTags: Tag[];
  }) => {
    const normalizedTitle = sanitize(result.Title);
    const normalizedTitleParts = normalizedTitle
      .split(' ')
      .filter((str) => str && str.trim());

    return {
      normalizedTitle,
      normalizedTitleParts,
      id: result.Guid,
      indexer:result.TrackerId,
      title: result.Title,
      quality: this.parseQuality(normalizedTitleParts, qualityParams),
      size: result.Size,
      seeders: result.Seeders,
      peers: result.Peers,
      link: result.Guid,
      // we filter out results wihtout link or magnet uri before
      // there will always be a download link
      downloadLink: (result.MagnetUri || result.Link) as string,
      tag: this.parseTag(normalizedTitleParts, preferredTags),
      publishDate: result.PublishDate,
    };
  };

  private parseTag(normalizedTitle: string[], preferredTags: Tag[]) {
    const tagMatch = preferredTags.find((tag) =>
      normalizedTitle.find((part) => part === tag.name.toLowerCase())
    );

    // we set score to 1 when there's not tag set
    // like this all results will be treated as potential result
    const unknownScore = preferredTags.length > 0 ? 0 : 1;

    return tagMatch
      ? { label: tagMatch.name, score: tagMatch.score }
      : { label: 'unknown', score: unknownScore };
  }

  private parseQuality(normalizedTitle: string[], qualityParams: Quality[]) {
    const qualityMatch = qualityParams.find((quality) =>
      quality.match.some((keyword) =>
        normalizedTitle.find((part) => part === keyword.toLowerCase())
      )
    );

    return qualityMatch
      ? { label: qualityMatch.name, score: qualityMatch.score }
      : { label: 'unknown', score: 0 };
  }

  private isLatin(title: string[]) {
    const hasNonLatin = /[^\p{Script=Latin}0-9 .,\/#!$%\^&\*;:{}=\-_`~()+?@]/gu;
    return !hasNonLatin.test(title);
  }
  private toLatin(toTranslate: string[]) {
    // https://github.com/stojanovic/cyrillic-to-latin/blob/master/cyrillicToLatin.js
    // TODO: Use import
    const cyrillic = 'А_Б_В_Г_Д_Ђ_Е_Ё_Ж_З_И_Й_Ј_К_Л_Љ_М_Н_Њ_О_П_Р_С_Т_Ћ_У_Ф_Х_Ц_Ч_Џ_Ш_Щ_Ъ_Ы_Ь_Э_Ю_Я_а_б_в_г_д_ђ_е_ё_ж_з_и_й_ј_к_л_љ_м_н_њ_о_п_р_с_т_ћ_у_ф_х_ц_ч_џ_ш_щ_ъ_ы_ь_э_ю_я'.split('_')
    const latin = 'A_B_V_G_D_Đ_E_Ë_Ž_Z_I_J_J_K_L_Lj_M_N_Nj_O_P_R_S_T_Ć_U_F_H_C_Č_Dž_Š_Ŝ_ʺ_Y_ʹ_È_Û_Â_a_b_v_g_d_đ_e_ë_ž_z_i_j_j_k_l_lj_m_n_nj_o_p_r_s_t_ć_u_f_h_c_č_dž_š_ŝ_ʺ_y_ʹ_è_û_â'.split('_')
    return toTranslate.split('').map(function(char) {
      const index = cyrillic.indexOf(char)
      if (!~index)
        return char
      return latin[index]
    }).join('')
  }
  private canSearchOriginalTitle(originalCountries: string[]) {
    // original titles may be hard to search on occidental trackers
    // they may return incorrect torrent to download
    return !originalCountries.some((country) =>
      ['CN', 'CH', 'JP'].includes(country)
    );
  }
}
