import stream from 'stream';
import zlib from 'zlib';
import util from 'util';

import { UploadFS } from '../../../../server/ufs';
import { Logger } from '../../../logger/server';
import { FileUploadClass, FileUpload } from '../lib/FileUpload';
import { getFileRange, setRangeHeaders } from '../lib/ranges';

const logger = new Logger('FileUpload');

function ExtractRange(options) {
	if (!(this instanceof ExtractRange)) {
		return new ExtractRange(options);
	}

	this.start = options.start;
	this.stop = options.stop;
	this.bytes_read = 0;

	stream.Transform.call(this, options);
}
util.inherits(ExtractRange, stream.Transform);

ExtractRange.prototype._transform = function (chunk, enc, cb) {
	if (this.bytes_read > this.stop) {
		// done reading
		this.end();
	} else if (this.bytes_read + chunk.length < this.start) {
		// this chunk is still before the start byte
	} else {
		let start;
		let stop;

		if (this.start <= this.bytes_read) {
			start = 0;
		} else {
			start = this.start - this.bytes_read;
		}
		if (this.stop - this.bytes_read + 1 < chunk.length) {
			stop = this.stop - this.bytes_read + 1;
		} else {
			stop = chunk.length;
		}
		const newchunk = chunk.slice(start, stop);
		this.push(newchunk);
	}
	this.bytes_read += chunk.length;
	cb();
};

// code from: https://github.com/jalik/jalik-ufs/blob/master/ufs-server.js#L310
const readFromGridFS = function (storeName, fileId, file, req, res) {
	const store = UploadFS.getStore(storeName);
	const rs = store.getReadStream(fileId, file);
	const ws = new stream.PassThrough();

	[rs, ws].forEach((stream) =>
		stream.on('error', function (err) {
			store.onReadError.call(store, err, fileId, file);
			res.end();
		}),
	);

	ws.on('close', function () {
		// Close output stream at the end
		ws.emit('end');
	});

	// Transform stream
	store.transformRead(rs, ws, fileId, file, req);

	const range = getFileRange(file, req);
	if (range) {
		setRangeHeaders(range, file, res);

		if (range.outOfRange) {
			return;
		}

		logger.debug('File upload extracting range');
		ws.pipe(new ExtractRange({ start: range.start, stop: range.stop })).pipe(res);
		return;
	}

	const accept = req.headers['accept-encoding'] || '';

	// Compress data using gzip
	if (accept.match(/\bgzip\b/)) {
		res.setHeader('Content-Encoding', 'gzip');
		res.removeHeader('Content-Length');
		res.writeHead(200);
		ws.pipe(zlib.createGzip()).pipe(res);
		return;
	}

	// Compress data using deflate
	if (accept.match(/\bdeflate\b/)) {
		res.setHeader('Content-Encoding', 'deflate');
		res.removeHeader('Content-Length');
		res.writeHead(200);
		ws.pipe(zlib.createDeflate()).pipe(res);
		return;
	}

	res.writeHead(200);
	ws.pipe(res);
};

const copyFromGridFS = function (storeName, fileId, file, out) {
	const store = UploadFS.getStore(storeName);
	const rs = store.getReadStream(fileId, file);

	[rs, out].forEach((stream) =>
		stream.on('error', function (err) {
			store.onReadError.call(store, err, fileId, file);
			out.end();
		}),
	);

	rs.pipe(out);
};

FileUpload.configureUploadsStore('GridFS', 'GridFS:Uploads', {
	collectionName: 'rocketchat_uploads',
});

FileUpload.configureUploadsStore('GridFS', 'GridFS:UserDataFiles', {
	collectionName: 'rocketchat_userDataFiles',
});

// DEPRECATED: backwards compatibility (remove)
UploadFS.getStores().rocketchat_uploads = UploadFS.getStores()['GridFS:Uploads'];

FileUpload.configureUploadsStore('GridFS', 'GridFS:Avatars', {
	collectionName: 'rocketchat_avatars',
});

new FileUploadClass({
	name: 'GridFS:Uploads',

	get(file, req, res) {
		file = FileUpload.addExtensionTo(file);

		res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`);
		res.setHeader('Last-Modified', file.uploadedAt.toUTCString());
		res.setHeader('Content-Type', file.type || 'application/octet-stream');
		res.setHeader('Content-Length', file.size);

		return readFromGridFS(file.store, file._id, file, req, res);
	},

	copy(file, out) {
		copyFromGridFS(file.store, file._id, file, out);
	},
});

new FileUploadClass({
	name: 'GridFS:UserDataFiles',

	get(file, req, res) {
		file = FileUpload.addExtensionTo(file);

		res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`);
		res.setHeader('Last-Modified', file.uploadedAt.toUTCString());
		res.setHeader('Content-Type', file.type);
		res.setHeader('Content-Length', file.size);

		return readFromGridFS(file.store, file._id, file, req, res);
	},

	copy(file, out) {
		copyFromGridFS(file.store, file._id, file, out);
	},
});

new FileUploadClass({
	name: 'GridFS:Avatars',

	get(file, req, res) {
		file = FileUpload.addExtensionTo(file);

		return readFromGridFS(file.store, file._id, file, req, res);
	},

	copy(file, out) {
		copyFromGridFS(file.store, file._id, file, out);
	},
});
