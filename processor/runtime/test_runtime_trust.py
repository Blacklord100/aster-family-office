import importlib.util
import os
from pathlib import Path
import ssl
import tempfile
from types import SimpleNamespace
import unittest

spec = importlib.util.spec_from_file_location('runtime_assembly', Path(__file__).with_name('assemble.py'))
assembly = importlib.util.module_from_spec(spec)
spec.loader.exec_module(assembly)


class RuntimeTrustTests(unittest.TestCase):
    def test_compiled_openssl_paths_alias_the_existing_bundle(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bundle = root / 'etc/ssl/certs/ca-certificates.crt'
            bundle.parent.mkdir(parents=True)
            certificate = ssl.create_default_context().get_ca_certs(binary_form=True)[0]
            bundle.write_text(ssl.DER_cert_to_PEM_cert(certificate))
            before = bundle.read_bytes()
            config = assembly.configure_trust(root, SimpleNamespace(
                openssl_cafile='/usr/lib/ssl/cert.pem', openssl_capath='/usr/lib/ssl/certs'))
            self.assertEqual(bundle.read_bytes(), before)
            self.assertEqual(os.readlink(root / 'usr/lib/ssl/cert.pem'), '/etc/ssl/certs/ca-certificates.crt')
            self.assertEqual(os.readlink(root / 'usr/lib/ssl/certs'), '/etc/ssl/certs')
            self.assertEqual(len(config['aliases']), 2)

    def test_missing_bundle_fails_instead_of_creating_empty_trust(self):
        with tempfile.TemporaryDirectory() as directory, self.assertRaises(OSError):
            assembly.configure_trust(Path(directory), SimpleNamespace(
                openssl_cafile='/usr/lib/ssl/cert.pem', openssl_capath='/usr/lib/ssl/certs'))


if __name__ == '__main__':
    unittest.main()
