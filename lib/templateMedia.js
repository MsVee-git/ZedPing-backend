const { MetaTemplateError } = require('./metaTemplates')

function validateTemplateHeaderMedia(file, type) {
  if (!file || !file.buffer || file.size < 1) {
    throw new MetaTemplateError('Select a valid ' + type + ' header file')
  }

  const bytes = file.buffer
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  const pdf = bytes.length >= 5 && bytes.subarray(0, 5).toString('ascii') === '%PDF-'

  if (type === 'image' && !(jpeg || png)) {
    throw new MetaTemplateError('Image headers must be JPEG or PNG files')
  }
  if (type === 'document' && !pdf) {
    throw new MetaTemplateError('Document headers must be PDF files')
  }
  const maximum = type === 'image' ? 5 * 1024 * 1024 : 10 * 1024 * 1024
  if (bytes.length > maximum) throw new MetaTemplateError(type === 'image' ? 'Image headers must be up to 5 MB' : 'Document headers must be up to 10 MB')
  return { ...file, mimetype: jpeg ? 'image/jpeg' : png ? 'image/png' : 'application/pdf' }
}

module.exports = { validateTemplateHeaderMedia }
