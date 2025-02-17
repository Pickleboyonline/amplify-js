// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { AWSS3Provider as StorageProvider } from '../../src/providers/AWSS3Provider';
import { Logger, Hub, Credentials, ICredentials } from '@aws-amplify/core';
import * as formatURL from '@aws-sdk/util-format-url';
import {
	S3Client,
	ListObjectsV2Command,
	CreateMultipartUploadCommand,
	UploadPartCommand,
} from '@aws-sdk/client-s3';
import { S3RequestPresigner } from '@aws-sdk/s3-request-presigner';

import {
	S3CopySource,
	S3CopyDestination,
	StorageOptions,
	S3ProviderGetConfig,
} from '../../src/types';
import { AWSS3UploadTask } from '../../src/providers/AWSS3UploadTask';
/**
 * NOTE - These test cases use Hub.dispatch but they should
 * actually be using dispatchStorageEvent from Storage
 */

const mockRemoveAllListeners = jest.fn();
const mockEventEmitter = {
	emit: jest.fn(),
	on: jest.fn(),
	removeAllListeners: mockRemoveAllListeners,
};

jest.mock('events', function () {
	return {
		EventEmitter: jest.fn().mockImplementation(() => mockEventEmitter),
	};
});

S3Client.prototype.send = jest.fn(async command => {
	if (command instanceof ListObjectsV2Command) {
		const resultObj = {
			Key: 'public/path/itemsKey',
			ETag: 'etag',
			LastModified: 'lastmodified',
			Size: 'size',
		};
		if (command.input.Prefix === 'public/emptyListResultsPath') {
			return {};
		}
		return {
			Contents: [resultObj],
			IsTruncated: false,
		};
	}
	return 'data';
});

S3RequestPresigner.prototype.presign = jest.fn(async (request, expires) => {
	return (Promise as any).resolve();
});

const credentials: ICredentials = {
	accessKeyId: 'accessKeyId',
	sessionToken: 'sessionToken',
	secretAccessKey: 'secretAccessKey',
	identityId: 'identityId',
	authenticated: true,
};

const options: StorageOptions = {
	bucket: 'bucket',
	region: 'region',
	credentials,
	level: 'public',
};

const options_no_cred = {
	bucket: 'bucket',
	region: 'region',
	credentials: null,
	level: 'level',
};

afterEach(() => {
	jest.restoreAllMocks();
	jest.clearAllMocks();
});

function listForNPages(pages) {
	const continuationToken = 'TEST_TOKEN';
	const listResultObj = {
		Key: 'public/path/itemsKey',
		ETag: 'etag',
		LastModified: 'lastmodified',
		Size: 'size',
	};
	let methodCalls = 0;
	return async command => {
		if (command instanceof ListObjectsV2Command) {
			let token: string | undefined = undefined;
			methodCalls++;
			if (command.input.ContinuationToken === undefined || methodCalls < pages)
				token = continuationToken;
			if (command.input.Prefix === 'public/listALLResultsPath') {
				return {
					Contents: [listResultObj],
					NextContinuationToken: token,
				};
			}
		}
		return 'data';
	};
}
describe('StorageProvider test', () => {
	let storage: StorageProvider;
	beforeEach(() => {
		storage = new StorageProvider();
		storage.configure(options);
	});
	describe('getCategory test', () => {
		test('happy case', () => {
			expect(storage.getCategory()).toBe('Storage');
		});
	});

	describe('getProviderName test', () => {
		test('happy case', () => {
			expect(storage.getProviderName()).toBe('AWSS3');
		});
	});

	describe('configure test', () => {
		test('standard configuration', () => {
			storage = new StorageProvider();

			const aws_options = {
				aws_user_files_s3_bucket: 'bucket',
				aws_user_files_s3_bucket_region: 'region',
			};

			const config = storage.configure(aws_options);
			expect(config).toEqual({
				AWSS3: {
					bucket: 'bucket',
					region: 'region',
				},
			});
		});

		test('configuration for local testing', () => {
			storage = new StorageProvider();

			const aws_options = {
				aws_user_files_s3_bucket: 'bucket',
				aws_user_files_s3_bucket_region: 'region',
				aws_user_files_s3_dangerously_connect_to_http_endpoint_for_testing:
					true,
			};

			const config = storage.configure(aws_options);
			expect(config).toEqual({
				AWSS3: {
					bucket: 'bucket',
					region: 'region',
					dangerouslyConnectToHttpEndpointForTesting: true,
				},
			});
		});
	});

	describe('get test', () => {
		test('get object without download', async () => {
			expect.assertions(3);
			jest.spyOn(Credentials, 'get').mockImplementationOnce(() => {
				return Promise.resolve(credentials);
			});
			const spyon = jest.spyOn(S3RequestPresigner.prototype, 'presign');
			jest.spyOn(formatURL, 'formatUrl').mockReturnValueOnce('url');

			expect(await storage.get('key', { download: false })).toBe('url');
			expect(spyon.mock.calls[0][0].path).toEqual('/public/key');
			expect(spyon.mock.calls[0][0].hostname).toEqual(
				`${options.bucket}.s3.${options.region}.amazonaws.com`
			);
		});

		test('get object with custom response headers', async () => {
			expect.assertions(4);
			const curCredSpyOn = jest
				.spyOn(Credentials, 'get')
				.mockImplementationOnce(() => {
					return Promise.resolve(credentials);
				});
			const spyon = jest.spyOn(S3RequestPresigner.prototype, 'presign');
			jest.spyOn(formatURL, 'formatUrl').mockReturnValueOnce('url');
			expect(
				await storage.get('key', {
					cacheControl: 'no-cache',
					contentDisposition: 'attachment; filename="filename.jpg"',
					contentEncoding: 'identity',
					contentLanguage: 'en-US',
					contentType: 'multipart/form-data; boundary=something',
					expires: 123456789,
				})
			).toBe('url');
			expect(spyon.mock.calls[0][0].query).toEqual({
				'response-cache-control': 'no-cache',
				'response-content-disposition': 'attachment; filename="filename.jpg"',
				'response-content-encoding': 'identity',
				'response-content-language': 'en-US',
				'response-content-type': 'multipart/form-data; boundary=something',
				'x-id': 'GetObject',
			});
			expect(spyon.mock.calls[0][0].path).toEqual('/public/key');
			expect(spyon.mock.calls[0][0].hostname).toEqual(
				`${options.bucket}.s3.${options.region}.amazonaws.com`
			);
			spyon.mockClear();
			curCredSpyOn.mockClear();
		});

		test('get object with tracking', async () => {
			expect.assertions(4);
			jest.spyOn(Credentials, 'get').mockImplementationOnce(() => {
				return Promise.resolve(credentials);
			});
			const spyon = jest.spyOn(S3RequestPresigner.prototype, 'presign');
			jest.spyOn(formatURL, 'formatUrl').mockReturnValueOnce('url');
			const spyon2 = jest.spyOn(Hub, 'dispatch');

			expect(await storage.get('key', { downloaded: false, track: true })).toBe(
				'url'
			);
			expect(spyon.mock.calls[0][0].path).toEqual('/public/key');
			expect(spyon.mock.calls[0][0].hostname).toEqual(
				`${options.bucket}.s3.${options.region}.amazonaws.com`
			);
			expect(spyon2).toBeCalledWith(
				'storage',
				{
					event: 'getSignedUrl',
					data: {
						attrs: { method: 'get', result: 'success' },
					},
					message: 'Signed URL: url',
				},
				'Storage',
				Symbol.for('amplify_default')
			);
		});

		test('get object with download successfully', async () => {
			expect.assertions(2);
			jest.spyOn(Credentials, 'get').mockImplementationOnce(() => {
				return Promise.resolve(credentials);
			});

			const options_with_download = Object.assign({}, options, {
				download: true,
			});
			storage = new StorageProvider();
			storage.configure(options_with_download);
			const spyon = jest
				.spyOn(S3Client.prototype, 'send')
				.mockImplementationOnce(async params => {
					return { Body: [1, 2] };
				});

			expect(await storage.get('key', { download: true })).toEqual({
				Body: [1, 2],
			});
			expect(spyon.mock.calls[0][0].input).toEqual({
				Bucket: 'bucket',
				Key: 'public/key',
			});
		});

		test('get object with download and progress tracker', async () => {
			jest.spyOn(Credentials, 'get').mockImplementationOnce(() => {
				return Promise.resolve(credentials);
			});
			const mockCallback = jest.fn();
			const downloadOptionsWithProgressCallback = Object.assign({}, options, {
				download: true,
				progressCallback: mockCallback,
			});
			storage = new StorageProvider();
			storage.configure(downloadOptionsWithProgressCallback);
			jest
				.spyOn(S3Client.prototype, 'send')
				.mockImplementationOnce(async params => {
					return { Body: [1, 2] };
				});
			expect(await storage.get('key', { download: true })).toEqual({
				Body: [1, 2],
			});
			expect(mockEventEmitter.on).toBeCalledWith(
				'sendDownloadProgress',
				expect.any(Function)
			);
			// Get the anonymous function called by the emitter
			const emitterOnFn = mockEventEmitter.on.mock.calls[0][1];
			// Manully invoke it for testing
			emitterOnFn('arg');
			expect(mockCallback).toBeCalledWith('arg');
			expect(mockRemoveAllListeners).toHaveBeenCalled();
		});

		test('get object with incorrect progressCallback type', async () => {
			jest.spyOn(Credentials, 'get').mockImplementationOnce(() => {
				return Promise.resolve(credentials);
			});
			const loggerSpy = jest.spyOn(Logger.prototype, '_log');
			const downloadOptionsWithProgressCallback = Object.assign({}, options);
			storage = new StorageProvider();
			storage.configure(downloadOptionsWithProgressCallback);
			jest
				.spyOn(S3Client.prototype, 'send')
				.mockImplementationOnce(async params => {
					return { Body: [1, 2] };
				});
			await storage.get('key', {
				download: true,
				progressCallback:
					'this is not a function' as unknown as S3ProviderGetConfig['progressCallback'], // this is intentional
			});
			expect(loggerSpy).toHaveBeenCalledWith(
				'WARN',
				'progressCallback should be a function, not a string'
			);
		});

		test('get object with download with failure', async () => {
			expect.assertions(1);
			jest.spyOn(Credentials, 'get').mockImplementationOnce(() => {
				return new Promise((res, rej) => {
					res({});
				});
			});
			jest
				.spyOn(S3Client.prototype, 'send')
				.mockImplementationOnce(async params => {
					throw 'err';
				});
			try {
				await storage.get('key', { download: true });
			} catch (e) {
				expect(e).toBe('err');
			}
		});

		test('get object with private option', async () => {
			expect.assertions(3);
			jest.spyOn(Credentials, 'get').mockImplementationOnce(() => {
				return new Promise((res, rej) => {
					res({
						identityId: 'id',
					});
				});
			});
			const spyon = jest.spyOn(S3RequestPresigner.prototype, 'presign');
			jest.spyOn(formatURL, 'formatUrl').mockReturnValueOnce('url');

			expect(await storage.get('key', { level: 'private' })).toBe('url');
			expect(spyon.mock.calls[0][0].path).toEqual('/private/id/key');
			expect(spyon.mock.calls[0][0].hostname).toEqual(
				`${options.bucket}.s3.${options.region}.amazonaws.com`
			);
		});

		test('sets an empty custom public key', async () => {
			jest.spyOn(Credentials, 'get').mockImplementationOnce(() => {
				return new Promise((res, rej) => {
					res({
						identityId: 'id',
					});
				});
			});
			const spyon = jest.spyOn(S3RequestPresigner.prototype, 'presign');
			jest.spyOn(formatURL, 'formatUrl').mockReturnValueOnce('url');
			await storage.get('my_key', { customPrefix: { public: '' } });
			expect(spyon.mock.calls[0][0].path).toEqual('/my_key');
			expect(spyon.mock.calls[0][0].hostname).toEqual(
				`${options.bucket}.s3.${options.region}.amazonaws.com`
			);
		});

		test('sets a custom key for public accesses', async () => {
			jest.spyOn(Credentials, 'get').mockImplementationOnce(() => {
				return new Promise((res, rej) => {
					res({
						identityId: 'id',
					});
				});
			});

			const spyon = jest.spyOn(S3RequestPresigner.prototype, 'presign');
			jest.spyOn(formatURL, 'formatUrl').mockReturnValueOnce('url');

			await storage.get('my_key', { customPrefix: { public: '123/' } });
			expect(spyon.mock.calls[0][0].path).toEqual('/123/my_key');
			expect(spyon.mock.calls[0][0].hostname).toEqual(
				`${options.bucket}.s3.${options.region}.amazonaws.com`
			);
		});

		test('get object with expires option', async () => {
			expect.assertions(4);
			jest.spyOn(Credentials, 'get').mockImplementationOnce(() => {
				return new Promise((res, rej) => {
					res({});
				});
			});
			const spyon = jest.spyOn(S3RequestPresigner.prototype, 'presign');
			jest.spyOn(formatURL, 'formatUrl').mockReturnValueOnce('url');

			expect(await storage.get('key', { expires: 1200 })).toBe('url');
			expect(spyon.mock.calls[0][0].path).toEqual('/public/key');
			expect(spyon.mock.calls[0][0].hostname).toEqual(
				`${options.bucket}.s3.${options.region}.amazonaws.com`
			);

			expect(spyon.mock.calls[0][1]?.expiresIn).toBe(1200);
		});

		test('get object with default expires option', async () => {
			expect.assertions(4);
			jest.spyOn(Credentials, 'get').mockImplementationOnce(() => {
				return new Promise((res, rej) => {
					res({});
				});
			});
			const spyon = jest.spyOn(S3RequestPresigner.prototype, 'presign');
			jest.spyOn(formatURL, 'formatUrl').mockReturnValueOnce('url');

			expect(await storage.get('key')).toBe('url');
			expect(spyon.mock.calls[0][0].path).toEqual('/public/key');
			expect(spyon.mock.calls[0][0].hostname).toEqual(
				`${options.bucket}.s3.${options.region}.amazonaws.com`
			);

			expect(spyon.mock.calls[0][1]?.expiresIn).toBe(900);
		});

		test('get object with identityId option', async () => {
			expect.assertions(3);
			jest.spyOn(Credentials, 'get').mockImplementationOnce(() => {
				return new Promise((res, rej) => {
					res({});
				});
			});
			const spyon = jest.spyOn(S3RequestPresigner.prototype, 'presign');
			jest.spyOn(formatURL, 'formatUrl').mockReturnValueOnce('url');

			expect(
				await storage.get('key', {
					level: 'protected',
					identityId: 'identityId',
				})
			).toBe('url');
			expect(spyon.mock.calls[0][0].path).toEqual('/protected/identityId/key');
			expect(spyon.mock.calls[0][0].hostname).toEqual(
				`${options.bucket}.s3.${options.region}.amazonaws.com`
			);
		});

		test('credentials not ok', async () => {
			expect.assertions(1);
			jest.spyOn(Credentials, 'get').mockImplementationOnce(() => {
				return new Promise((res, rej) => {
					rej('err');
				});
			});

			storage = new StorageProvider();
			storage.configure(options_no_cred);

			try {
				await storage.get('key', {});
			} catch (e) {
				expect(e).not.toBeNull();
			}
		});

		test('always ask for the current credentials', async () => {
			jest.spyOn(S3RequestPresigner.prototype, 'presign');
			jest.spyOn(formatURL, 'formatUrl').mockReturnValue('url');
			const curCredSpyOn = jest
				.spyOn(Credentials, 'get')
				.mockImplementationOnce(() => {
					return new Promise((res, rej) => {
						res({
							cred: 'cred1',
						});
					});
				});

			await storage.get('key', { download: false });

			jest.spyOn(Credentials, 'get').mockImplementationOnce(() => {
				return new Promise((res, rej) => {
					res({
						cred: 'cred2',
					});
				});
			});

			await storage.get('key', { download: false });

			expect(curCredSpyOn.mock.calls.length).toBe(2);

			curCredSpyOn.mockClear();
		});
	});

	describe('put test', () => {
		afterEach(() => {
			jest.clearAllMocks();
		});
		test('put object successfully', async () => {
			expect.assertions(2);
			jest.spyOn(Credentials, 'get').mockImplementationOnce(() => {
				return new Promise((res, rej) => {
					res({});
				});
			});
			const spyon = jest.spyOn(S3Client.prototype, 'send');

			expect(await storage.put('key', 'object', { acl: 'public' })).toEqual({
				key: 'key',
			});

			expect(spyon.mock.calls[0][0].input).toEqual({
				ACL: 'public',
				Body: 'object',
				Bucket: 'bucket',
				ContentType: 'binary/octet-stream',
				Key: 'key',
			});
		});

		test('put object with track', async () => {
			expect.assertions(3);
			jest.spyOn(Credentials, 'get').mockImplementationOnce(() => {
				return new Promise((res, rej) => {
					res({});
				});
			});
			const spyon = jest.spyOn(S3Client.prototype, 'send');
			const spyon2 = jest.spyOn(Hub, 'dispatch');

			expect(await storage.put('key', 'object', { track: true })).toEqual({
				key: 'key',
			});
			expect(spyon.mock.calls[0][0].input).toEqual({
				Body: 'object',
				Bucket: 'bucket',
				ContentType: 'binary/octet-stream',
				Key: 'key',
			});
			expect(spyon2).toBeCalledWith(
				'storage',
				{
					event: 'upload',
					data: {
						attrs: {
							method: 'put',
							result: 'success',
						},
					},
					message: 'Upload success for key',
				},
				'Storage',
				Symbol.for('amplify_default')
			);
		});

		test('put object failed', async () => {
			expect.assertions(1);
			jest.spyOn(Credentials, 'get').mockImplementationOnce(() => {
				return new Promise((res, rej) => {
					res({});
				});
			});
			jest
				.spyOn(S3Client.prototype, 'send')
				.mockImplementationOnce(async params => {
					throw 'err';
				});

			try {
				await storage.put('key', 'object', {});
			} catch (e) {
				expect(e).toBe('err');
			}
		});

		test('put object with private and contenttype specified', async () => {
			expect.assertions(2);
			jest.spyOn(Credentials, 'get').mockImplementationOnce(() => {
				return new Promise((res, rej) => {
					res({
						identityId: 'id',
					});
				});
			});
			const spyon = jest.spyOn(S3Client.prototype, 'send');
			expect(
				await storage.put('key', 'object', {
					level: 'private',
					contentType: 'text/plain',
				})
			).toEqual({ key: 'key' });
			expect(spyon.mock.calls[0][0].input).toEqual({
				Body: 'object',
				Bucket: 'bucket',
				ContentType: 'text/plain',
				Key: 'key',
			});
		});

		test('put object with extra config passed to s3 calls', async () => {
			jest.spyOn(Credentials, 'get').mockImplementationOnce(() => {
				return new Promise((res, _rej) => {
					res({
						identityId: 'id',
					});
				});
			});
			const spyon = jest.spyOn(S3Client.prototype, 'send');
			const date = new Date();
			const metadata = { key: 'value' };
			expect(
				await storage.put('key', 'object', {
					level: 'private',
					contentType: 'text/plain',
					cacheControl: 'no-cache',
					contentDisposition: 'inline',
					contentEncoding: 'gzip',
					expires: date,
					metadata,
					tagging: 'key1=value1',
					serverSideEncryption: 'AES256',
					SSECustomerAlgorithm: 'AES256',
					SSECustomerKey: 'key',
					SSECustomerKeyMD5: 'md5',
					SSEKMSKeyId: 'id',
				})
			).toEqual({ key: 'key' });
			expect(spyon.mock.calls[0][0].input).toStrictEqual({
				Body: 'object',
				Bucket: 'bucket',
				ContentType: 'text/plain',
				Key: 'key',
				CacheControl: 'no-cache',
				ContentEncoding: 'gzip',
				ContentDisposition: 'inline',
				Expires: date,
				Metadata: metadata,
				Tagging: 'key1=value1',
				SSECustomerAlgorithm: 'AES256',
				SSECustomerKey: 'key',
				SSECustomerKeyMD5: 'md5',
				ServerSideEncryption: 'AES256',
				SSEKMSKeyId: 'id',
			});
		});

		test('progress callback should be called', async () => {
			jest.spyOn(Credentials, 'get').mockImplementationOnce(() => {
				return new Promise((res, _rej) => {
					res({
						identityId: 'id',
					});
				});
			});
			const mockCallback = jest.fn();
			await storage.put('key', 'object', {
				progressCallback: mockCallback,
			});
			expect(mockEventEmitter.on).toBeCalledWith(
				'sendUploadProgress',
				expect.any(Function)
			);
			const emitterOnFn = mockEventEmitter.on.mock.calls[0][1];
			// Manually invoke for testing
			emitterOnFn('arg');
			expect(mockCallback).toBeCalledWith('arg');
		});

		test('non-function progress callback should give a warning', async () => {
			jest.spyOn(Credentials, 'get').mockImplementationOnce(() => {
				return new Promise((res, _rej) => {
					res({
						identityId: 'id',
					});
				});
			});
			const loggerSpy = jest.spyOn(Logger.prototype, '_log');
			await storage.put('key', 'object', {
				progressCallback:
					'hello' as unknown as S3ProviderGetConfig['progressCallback'], // this is intentional
			});
			expect(loggerSpy).toHaveBeenCalledWith(
				'WARN',
				'progressCallback should be a function, not a string'
			);
		});

		test('put (resumable upload) returns instance of AWSS3UploadTask', async () => {
			jest.spyOn(Credentials, 'get').mockImplementation(() => {
				return Promise.resolve(credentials);
			});

			const file = new File(['TestFileContent'], 'testFileName');
			const testUploadId = 'testUploadId';

			jest
				.spyOn(S3Client.prototype, 'send')
				.mockImplementationOnce(async command => {
					if (command instanceof CreateMultipartUploadCommand) {
						return Promise.resolve({ UploadId: testUploadId });
					} else if (command instanceof UploadPartCommand) {
						return Promise.resolve({
							ETag: 'test_etag_' + command.input.PartNumber,
						});
					}
				});

			const uploadTask = storage.put('key', file, {
				resumable: true,
			});

			expect(uploadTask instanceof AWSS3UploadTask).toEqual(true);
		});

		test('put (resumable upload) with extra config passed to s3 call', async () => {
			jest.spyOn(Credentials, 'get').mockImplementation(() => {
				return Promise.resolve(credentials);
			});

			const file = new File(['TestFileContent'], 'testFileName');
			const testUploadId = 'testUploadId';

			const s3ServiceCallSpy = jest
				.spyOn(S3Client.prototype, 'send')
				.mockImplementationOnce(async command => {
					if (command instanceof CreateMultipartUploadCommand) {
						return Promise.resolve({ UploadId: testUploadId });
					} else if (command instanceof UploadPartCommand) {
					}
				});

			const date = new Date();
			const metadata = { key: 'value' };
			const task = storage.put('key', file, {
				resumable: true,
				contentType: 'application/pdf',
				cacheControl: 'no-cache',
				contentDisposition: 'inline',
				contentEncoding: 'gzip',
				expires: date,
				metadata,
				tagging: 'key1=value1',
				serverSideEncryption: 'AES256',
				SSECustomerAlgorithm: 'AES256',
				SSECustomerKey: 'key',
				SSECustomerKeyMD5: 'md5',
				SSEKMSKeyId: 'id',
				acl: 'public',
				progressCallback: async () => {
					expect(s3ServiceCallSpy.mock.calls[0][0].input).toStrictEqual({
						Body: file,
						Bucket: 'bucket',
						ContentType: 'application/pdf',
						Key: 'key',
						CacheControl: 'no-cache',
						ContentEncoding: 'gzip',
						ContentDisposition: 'inline',
						Expires: date,
						Metadata: metadata,
						Tagging: 'key1=value1',
						SSECustomerAlgorithm: 'AES256',
						SSECustomerKey: 'key',
						SSECustomerKeyMD5: 'md5',
						ServerSideEncryption: 'AES256',
						SSEKMSKeyId: 'id',
						ACL: 'public',
					});
					await (task as AWSS3UploadTask)._cancel();
				},
			});
		});
	});

	describe('remove test', () => {
		afterEach(() => {
			jest.clearAllMocks();
		});
		test('remove object successfully', async () => {
			expect.assertions(2);
			jest.spyOn(Credentials, 'get').mockImplementationOnce(() => {
				return new Promise((res, rej) => {
					res({});
				});
			});
			const spyon = jest.spyOn(S3Client.prototype, 'send');

			expect(await storage.remove('key', {})).toBe('data');
			expect(spyon.mock.calls[0][0].input).toEqual({
				Bucket: 'bucket',
				Key: 'public/key',
			});
		});

		test('remove object with track', async () => {
			expect.assertions(3);
			jest.spyOn(Credentials, 'get').mockImplementationOnce(() => {
				return new Promise((res, rej) => {
					res({});
				});
			});

			const spyon = jest.spyOn(S3Client.prototype, 'send');
			const spyon2 = jest.spyOn(Hub, 'dispatch');

			expect(await storage.remove('key', { track: true })).toBe('data');
			expect(spyon.mock.calls[0][0].input).toEqual({
				Bucket: 'bucket',
				Key: 'public/key',
			});
			expect(spyon2).toBeCalledWith(
				'storage',
				{
					event: 'delete',
					data: {
						attrs: { method: 'remove', result: 'success' },
					},
					message: 'Deleted key successfully',
				},
				'Storage',
				Symbol.for('amplify_default')
			);
		});

		test('remove object failed', async () => {
			expect.assertions(1);
			jest.spyOn(Credentials, 'get').mockImplementationOnce(() => {
				return new Promise((res, rej) => {
					res({});
				});
			});
			jest
				.spyOn(S3Client.prototype, 'send')
				.mockImplementationOnce(async params => {
					throw 'err';
				});

			try {
				await storage.remove('key', {});
			} catch (e) {
				expect(e).toBe('err');
			}
		});

		test('remove object with private', async () => {
			expect.assertions(2);
			jest.spyOn(Credentials, 'get').mockImplementationOnce(() => {
				return new Promise((res, rej) => {
					res({
						identityId: 'id',
					});
				});
			});

			const spyon = jest.spyOn(S3Client.prototype, 'send');

			expect(await storage.remove('key', { level: 'private' })).toBe('data');
			expect(spyon.mock.calls[0][0].input).toEqual({
				Bucket: 'bucket',
				Key: 'private/id/key',
			});
		});

		test('credentials not ok', async () => {
			jest.spyOn(Credentials, 'get').mockImplementationOnce(() => {
				return new Promise((res, rej) => {
					rej('err');
				});
			});

			storage = new StorageProvider();
			storage.configure(options_no_cred);
			expect.assertions(1);
			try {
				await storage.remove('key', {});
			} catch (e) {
				expect(e).not.toBeNull();
			}
		});
	});

	describe('list test', () => {
		const resultObj = {
			eTag: 'etag',
			key: 'path/itemsKey',
			lastModified: 'lastmodified',
			size: 'size',
		};
		const listResultObj = {
			Key: 'public/path/itemsKey',
			ETag: 'etag',
			LastModified: 'lastmodified',
			Size: 'size',
		};
		function commandInput(token) {
			return {
				Bucket: 'bucket',
				Prefix: 'public/listALLResultsPath',
				MaxKeys: 1000,
				ContinuationToken: token,
			};
		}
		const listResult = [resultObj, resultObj, resultObj];
		test('list object successfully having three pages', async () => {
			expect.assertions(5);
			jest.spyOn(Credentials, 'get').mockImplementationOnce(() => {
				return new Promise((res, rej) => {
					res({});
				});
			});
			const spyon = jest
				.spyOn(S3Client.prototype, 'send')
				.mockImplementation(listForNPages(3));
			let response = await storage.list('listALLResultsPath', {
				level: 'public',
				pageSize: 'ALL',
			});
			expect(response.results).toEqual(listResult);
			expect(response.hasNextToken).toEqual(false);
			// listing three times for three pages
			expect(spyon).toHaveBeenCalledTimes(3);
			// first input recieves undefined as the Continuation Token
			expect(spyon.mock.calls[0][0].input).toEqual(commandInput(undefined));
			// last input recieves TEST_TOKEN as the Continuation Token
			expect(spyon.mock.calls[2][0].input).toEqual(commandInput('TEST_TOKEN'));
			spyon.mockClear();
		});
		test('list objects with zero results', async () => {
			expect.assertions(2);
			jest.spyOn(Credentials, 'get').mockImplementationOnce(() => {
				return new Promise((res, rej) => {
					res({});
				});
			});
			const spyon = jest.spyOn(S3Client.prototype, 'send');
			let response = await storage.list('emptyListResultsPath', {
				level: 'public',
			});

			expect(response.results).toEqual([]);
			expect(spyon.mock.calls[0][0].input).toEqual({
				Bucket: 'bucket',
				MaxKeys: 1000,
				Prefix: 'public/emptyListResultsPath',
			});
			spyon.mockClear();
		});

		test('list object with track having three pages', async () => {
			expect.assertions(5);
			jest.spyOn(Credentials, 'get').mockImplementationOnce(() => {
				return new Promise((res, rej) => {
					res({});
				});
			});
			const spyon = jest
				.spyOn(S3Client.prototype, 'send')
				.mockImplementation(listForNPages(3));

			let response = await storage.list('listALLResultsPath', {
				level: 'public',
				track: true,
				pageSize: 'ALL',
			});
			expect(response.results).toEqual(listResult);
			expect(response.hasNextToken).toEqual(false);
			// listing three times for three pages
			expect(spyon).toHaveBeenCalledTimes(3);
			// first input recieves undefined as the Continuation Token
			expect(spyon.mock.calls[0][0].input).toEqual(commandInput(undefined));
			// last input recieves TEST_TOKEN as the Continuation Token
			expect(spyon.mock.calls[2][0].input).toEqual(commandInput('TEST_TOKEN'));
			spyon.mockClear();
		});

		test('list object with pageSize and nextToken', async () => {
			expect.assertions(4);
			const curCredSpyOn = jest
				.spyOn(Credentials, 'get')
				.mockImplementationOnce(() => {
					return new Promise((res, rej) => {
						res({});
					});
				});
			const listWithTokenFunction = async command => {
				if (command instanceof ListObjectsV2Command) {
					if (command.input.Prefix === 'public/listWithTokenResultsPath') {
						return {
							Contents: [listResultObj],
							NextContinuationToken: 'TEST_TOKEN',
							IsTruncated: true,
						};
					}
				}
				return 'data';
			};
			const spyon = jest
				.spyOn(S3Client.prototype, 'send')
				.mockImplementation(listWithTokenFunction);

			const response = await storage.list('listWithTokenResultsPath', {
				level: 'public',
				pageSize: 1,
				nextToken: 'TEST_TOKEN',
			});
			expect(response.results).toEqual([
				{
					eTag: 'etag',
					key: 'path/itemsKey',
					lastModified: 'lastmodified',
					size: 'size',
				},
			]);
			expect(response.nextToken).toEqual('TEST_TOKEN');
			expect(response.hasNextToken).toEqual(true);
			expect(spyon.mock.calls[0][0].input).toEqual({
				Bucket: 'bucket',
				Prefix: 'public/listWithTokenResultsPath',
				ContinuationToken: 'TEST_TOKEN',
				MaxKeys: 1,
			});
			spyon.mockClear();
			curCredSpyOn.mockClear();
		});

		test('list object failed', async () => {
			expect.assertions(1);
			jest.spyOn(Credentials, 'get').mockImplementationOnce(() => {
				return new Promise((res, rej) => {
					res({});
				});
			});
			jest
				.spyOn(S3Client.prototype, 'send')
				.mockImplementationOnce(async params => {
					throw 'err';
				});

			try {
				await storage.list('path', {});
			} catch (e) {
				expect(e).toBe('err');
			}
		});

		test('credentials not ok', async () => {
			expect.assertions(1);
			jest.spyOn(Credentials, 'get').mockImplementationOnce(() => {
				return new Promise((res, rej) => {
					rej('err');
				});
			});

			storage = new StorageProvider();
			storage.configure(options_no_cred);

			try {
				await storage.list('path', {});
			} catch (e) {
				expect(e).not.toBeNull();
			}
		});
	});

	describe('copy test', () => {
		afterEach(() => {
			jest.clearAllMocks();
			jest.restoreAllMocks();
		});

		test('copy object successfully', async () => {
			jest.spyOn(Credentials, 'get').mockImplementation(() => {
				return Promise.resolve(credentials);
			});
			const spyon = jest.spyOn(S3Client.prototype, 'send');

			expect(await storage.copy({ key: 'src' }, { key: 'dest' })).toEqual({
				key: 'dest',
			});
			expect(spyon.mock.calls[0][0].input).toStrictEqual({
				Bucket: 'bucket',
				// Should default to public if no level is specified
				CopySource: 'bucket/public/src',
				Key: 'public/dest',
				MetadataDirective: 'COPY',
			});
			expect(spyon).toBeCalledTimes(1);
		});

		test('copy with invalid source key should throw error', async () => {
			jest.spyOn(Credentials, 'get').mockImplementation(() => {
				return Promise.resolve(credentials);
			});

			// No src key
			await expect(
				storage.copy({ level: 'public' } as S3CopySource, {
					key: 'dest',
					level: 'public',
				})
			).rejects.toThrowError(
				'source param should be an object with the property "key" with value of type string'
			);

			// wrong key type
			await expect(
				storage.copy({ level: 'public', key: 123 } as unknown as S3CopySource, {
					key: 'dest',
					level: 'public',
				})
			).rejects.toThrowError(
				'source param should be an object with the property "key" with value of type string'
			);
		});

		test('copy with invalid destination key should throw error', async () => {
			jest.spyOn(Credentials, 'get').mockImplementation(() => {
				return Promise.resolve(credentials);
			});

			// No dest key
			await expect(
				storage.copy({ key: 'src', level: 'public' }, {
					level: 'public',
				} as S3CopyDestination)
			).rejects.toThrowError(
				'destination param should be an object with the property "key" with value of type string'
			);

			// wrong key type
			await expect(
				storage.copy({ key: 'src', level: 'public' }, {
					key: 123,
					level: 'public',
				} as unknown as S3CopyDestination)
			).rejects.toThrowError(
				'destination param should be an object with the property "key" with value of type string'
			);
		});

		test('copy object with track', async () => {
			jest.spyOn(Credentials, 'get').mockImplementation(() => {
				return Promise.resolve(credentials);
			});

			const spyon = jest.spyOn(S3Client.prototype, 'send');
			const spyon2 = jest.spyOn(Hub, 'dispatch');

			await storage.copy({ key: 'src' }, { key: 'dest' }, { track: true });
			expect(spyon).toBeCalledTimes(1);
			expect(spyon2).toBeCalledWith(
				'storage',
				{
					event: 'copy',
					data: {
						attrs: {
							method: 'copy',
							result: 'success',
						},
					},
					message: 'Copy success from src to dest',
				},
				'Storage',
				Symbol.for('amplify_default')
			);
		});

		test('copy object with level and identityId specified', async () => {
			jest.spyOn(Credentials, 'get').mockImplementation(() => {
				return Promise.resolve(credentials);
			});
			const spyon = jest.spyOn(S3Client.prototype, 'send');
			await storage.copy(
				{ key: 'src', level: 'protected', identityId: 'identityId2' },
				{ key: 'dest', level: 'private' }
			);

			expect(spyon.mock.calls[0][0].input).toStrictEqual({
				Bucket: 'bucket',
				CopySource: 'bucket/protected/identityId2/src',
				Key: 'private/identityId/dest',
				MetadataDirective: 'COPY',
			});
		});

		test('copy with custom s3 configs', async () => {
			jest.spyOn(Credentials, 'get').mockImplementation(() => {
				return Promise.resolve(credentials);
			});
			const spyon = jest.spyOn(S3Client.prototype, 'send');
			const date = new Date();
			await storage.copy(
				{ key: 'src', level: 'protected' },
				{ key: 'dest', level: 'protected' },
				{
					acl: 'private',
					bucket: 'bucket',
					cacheControl: 'cacheControl',
					expires: date,
					serverSideEncryption: 'serverSideEncryption',
					SSECustomerAlgorithm: 'SSECustomerAlgorithm',
					SSECustomerKey: 'SSECustomerKey',
					SSECustomerKeyMD5: 'SSECustomerKeyMD5',
					SSEKMSKeyId: 'SSEKMSKeyId',
				}
			);

			expect(spyon.mock.calls[0][0].input).toStrictEqual({
				ACL: 'private',
				Bucket: 'bucket',
				CopySource: 'bucket/protected/identityId/src',
				CacheControl: 'cacheControl',
				Expires: date,
				ServerSideEncryption: 'serverSideEncryption',
				Key: 'protected/identityId/dest',
				SSECustomerAlgorithm: 'SSECustomerAlgorithm',
				SSECustomerKey: 'SSECustomerKey',
				SSECustomerKeyMD5: 'SSECustomerKeyMD5',
				SSEKMSKeyId: 'SSEKMSKeyId',
				MetadataDirective: 'COPY',
			});
		});

		test('copy object failed', async () => {
			jest.spyOn(Credentials, 'get').mockImplementation(() => {
				return Promise.resolve(credentials);
			});
			const spyon = jest
				.spyOn(S3Client.prototype, 'send')
				.mockImplementation(async () => {
					throw new Error('err');
				});
			await expect(
				storage.copy({ key: 'src' }, { key: 'dest' })
			).rejects.toThrow('err');
			expect(spyon).toBeCalledTimes(1);
		});

		test('credentials not ok', async () => {
			storage = new StorageProvider();
			storage.configure(options_no_cred);
			await expect(
				storage.copy({ key: 'src' }, { key: 'dest' })
			).rejects.toThrowError('No credentials');
		});
	});
});
